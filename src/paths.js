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

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  if (!contains(canonicalRoot, canonicalTarget)) {
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
