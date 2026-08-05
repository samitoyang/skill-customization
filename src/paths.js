import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

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

export async function resolveOwnedPath(root, relativePath, { rejectSymlinks = false } = {}) {
  const canonicalRoot = await realpath(root);
  const unresolved = path.join(root, relativePath);
  const canonicalTarget = await realpath(unresolved);
  if (!contains(canonicalRoot, canonicalTarget)) {
    throw new Error(`${relativePath} resolves outside its customization folder`);
  }
  if (rejectSymlinks) await assertNoSymlinks(unresolved);
  return canonicalTarget;
}
