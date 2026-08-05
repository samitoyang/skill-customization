import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

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

async function listTree(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      result.push({ type: "directory", relative });
      result.push(...(await listTree(root, absolute)));
    } else if (entry.isSymbolicLink()) {
      result.push({ type: "symlink", relative, target: await readlink(absolute) });
    } else if (entry.isFile()) {
      result.push({ type: "file", relative, bytes: await readFile(absolute) });
    }
  }
  return result;
}

export async function fingerprintPath(targetPath) {
  const info = await lstat(targetPath);
  if (info.isFile()) return fingerprintFile(targetPath);
  if (info.isSymbolicLink()) {
    const hash = createHash("sha256");
    frame(hash, "symlink");
    frame(hash, await readlink(targetPath));
    return digest(hash);
  }
  if (!info.isDirectory()) throw new TypeError("only files, directories, and symlinks can be fingerprinted");
  const hash = createHash("sha256");
  frame(hash, "skill-customization-directory-v1");
  for (const entry of await listTree(targetPath)) {
    frame(hash, entry.type);
    frame(hash, entry.relative);
    if (entry.bytes) frame(hash, entry.bytes);
    if (entry.target) frame(hash, entry.target);
  }
  return digest(hash);
}
