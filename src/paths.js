import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { isOwnedPayloadExcludedPath } from "./owned-payload.js";

export function isMachineAbsolutePath(value) {
  if (typeof value !== "string") return false;
  return (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^file:/i.test(value) ||
    /^~[^\\/]*(?:[\\/]|$)/.test(value)
  );
}

export function isPathContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  const escapesRoot = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!escapesRoot && !path.isAbsolute(relative));
}

// Resolve a path through every existing ancestor without requiring the leaf
// itself to exist.  Evidence and fingerprint exclusions use this same seam so
// a state path reached through a source symlink names the same file as the
// traversal that validates the source.
export async function canonicalPath(
  candidatePath,
  { preserveLeafSymlink = true } = {},
) {
  const original = path.resolve(candidatePath);
  let cursor = original;
  const suffix = [];
  while (true) {
    try {
      await lstat(cursor);
      const canonical = preserveLeafSymlink && suffix.length === 0
        ? path.join(
            path.resolve(await realpath(path.dirname(cursor))),
            path.basename(cursor),
          )
        : path.resolve(await realpath(cursor));
      return path.join(canonical, ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return original;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function statePathExclusions(statePath) {
  if (typeof statePath !== "string" || !statePath.trim()) return [];
  const resolved = path.resolve(statePath);
  return [resolved, `${resolved}.lock`];
}

async function assertNoSymlinks(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`symbolic link is not owned provenance: ${target}`);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(target)) {
    await assertNoSymlinks(path.join(target, entry));
  }
}

async function assertNoSymlinkSegments(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(`symbolic link is not owned provenance: ${current}`);
    }
  }
}

export async function resolveOwnedPath(
  root,
  relativePath,
  { rejectExcludedRoots = false, rejectSymlinks = false } = {},
) {
  const canonicalRoot = await realpath(root);
  const unresolved = path.join(root, relativePath);
  const canonicalTarget = await realpath(unresolved);
  if (!isPathContained(canonicalRoot, canonicalTarget)) {
    throw new Error(`${relativePath} resolves outside its customization folder`);
  }
  const canonicalRelative = path
    .relative(canonicalRoot, canonicalTarget)
    .split(path.sep)
    .join("/");
  if (rejectExcludedRoots && isOwnedPayloadExcludedPath(canonicalRelative)) {
    throw new Error(`${relativePath} resolves to an excluded owned-payload path`);
  }
  if (rejectSymlinks) {
    await assertNoSymlinkSegments(root, relativePath);
    await assertNoSymlinks(unresolved);
  }
  return canonicalTarget;
}
