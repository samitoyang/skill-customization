import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { DESCRIPTOR_INVARIANTS } from "./descriptor-invariants.js";
import { isOwnedPayloadExcludedPath } from "./owned-payload.js";

const NON_MACHINE_PATHS = DESCRIPTOR_INVARIANTS.patterns.nonMachinePath.map(
  (source) => new RegExp(source),
);

export function isMachineAbsolutePath(value) {
  if (typeof value !== "string") return false;
  return NON_MACHINE_PATHS.some((pattern) => pattern.test(value));
}

export function isPathContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  const escapesRoot = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!escapesRoot && !path.isAbsolute(relative));
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
