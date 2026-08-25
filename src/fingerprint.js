import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  isOwnedPayloadExcludedPath,
  isSourceFingerprintExcludedPath,
} from "./owned-payload.js";

function digest(hash) {
  return `sha256:${hash.digest("hex")}`;
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

function symbolicLinkError(relative) {
  const error = new TypeError(
    `directory fingerprint contains a symbolic link: ${relative}`,
  );
  error.code = "FINGERPRINT_SYMLINK";
  return error;
}

function unsupportedFingerprintNodeError(relative) {
  const error = new TypeError(
    `directory fingerprint contains an unsupported filesystem node: ${relative}`,
  );
  error.code = "FINGERPRINT_UNSUPPORTED_NODE";
  return error;
}

function unsupportedOwnedPayloadNodeError(relative) {
  const error = new TypeError(
    `owned payload contains an unsupported filesystem node: ${relative}`,
  );
  error.code = "OWNED_PAYLOAD_UNSUPPORTED_NODE";
  return error;
}

export function fingerprintValues(values, domain = "skill-customization-values-v1") {
  const hash = createHash("sha256");
  frame(hash, domain);
  for (const value of values) frame(hash, value);
  return digest(hash);
}

export async function fingerprintFile(filePath) {
  const bytes = await readFile(filePath);
  return digest(createHash("sha256").update(bytes));
}

export async function fingerprintFiles(filePaths) {
  const hash = createHash("sha256");
  frame(hash, "skill-customization-files-v1");
  for (const [index, filePath] of filePaths.entries()) {
    frame(hash, String(index));
    frame(hash, await readFile(filePath));
  }
  return digest(hash);
}

function isPathWithin(ancestor, candidate) {
  const relative = path.relative(ancestor, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

async function canonicalExcludedPath(candidatePath) {
  const original = path.resolve(candidatePath);
  let cursor = original;
  const suffix = [];
  while (true) {
    try {
      await lstat(cursor);
      const canonicalParent = path.resolve(await realpath(path.dirname(cursor)));
      return path.join(canonicalParent, path.basename(cursor), ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return original;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function listTree(root, current = root, excludedPaths = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (isSourceFingerprintExcludedPath(relative)) continue;
    if (excludedPaths.some((excluded) => path.resolve(excluded) === absolute)) continue;
    if (entry.isDirectory()) {
      const suppressDirectory = excludedPaths.some((excluded) =>
        isPathWithin(absolute, path.resolve(excluded)));
      if (!suppressDirectory) result.push({ type: "directory", relative });
      result.push(...(await listTree(root, absolute, excludedPaths)));
    } else if (entry.isSymbolicLink()) {
      throw symbolicLinkError(relative);
    } else if (entry.isFile()) {
      result.push({ type: "file", relative, bytes: await readFile(absolute) });
    } else {
      throw unsupportedFingerprintNodeError(relative);
    }
  }
  return result;
}

async function listOwnedPayload(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (isOwnedPayloadExcludedPath(relative)) continue;
    if (entry.isSymbolicLink()) {
      const error = new TypeError(`owned payload contains a symbolic link: ${relative}`);
      error.code = "OWNED_PAYLOAD_SYMLINK";
      throw error;
    }
    if (entry.isDirectory()) {
      result.push(...(await listOwnedPayload(root, absolute)));
    } else if (entry.isFile()) {
      result.push({ relative, bytes: await readFile(absolute) });
    } else {
      throw unsupportedOwnedPayloadNodeError(relative);
    }
  }
  return result;
}

export async function payloadFingerprint(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError("owned payload root must be a real directory");
  }
  const hash = createHash("sha256");
  frame(hash, "skill-customization-owned-payload-v1");
  for (const entry of await listOwnedPayload(directory)) {
    frame(hash, entry.relative);
    frame(hash, entry.bytes);
  }
  return digest(hash);
}

export async function fingerprintPath(targetPath, { excludedPaths = [] } = {}) {
  const info = await lstat(targetPath);
  if (info.isFile()) return fingerprintFile(targetPath);
  if (info.isSymbolicLink()) {
    return fingerprintPath(await realpath(targetPath), { excludedPaths });
  }
  if (!info.isDirectory()) throw new TypeError("only files, directories, and symlinks can be fingerprinted");
  const canonicalRoot = path.resolve(await realpath(targetPath));
  const hash = createHash("sha256");
  frame(hash, "skill-customization-directory-v1");
  const normalizedExcludedPaths = [...new Set(await Promise.all(excludedPaths
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => canonicalExcludedPath(candidate))))];
  for (const entry of await listTree(canonicalRoot, canonicalRoot, normalizedExcludedPaths)) {
    frame(hash, entry.type);
    frame(hash, entry.relative);
    if (entry.bytes) frame(hash, entry.bytes);
  }
  return digest(hash);
}
