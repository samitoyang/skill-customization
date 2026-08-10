import path from "node:path";
import { lstat, mkdir, readFile } from "node:fs/promises";

import {
  assertValidDescriptor,
  readDescriptor,
} from "./descriptor.js";
import {
  fingerprintFile,
  fingerprintPath,
  payloadFingerprint,
} from "./fingerprint.js";
import { resolveOwnedPath } from "./paths.js";
import {
  acquireStateLock,
  writeFileAtomic,
  writeJsonAtomic,
} from "./state.js";

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

async function maintenanceLockPath(descriptorPath) {
  const root = path.dirname(descriptorPath);
  const provenancePath = path.join(root, "provenance");
  await mkdir(provenancePath).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const ownedProvenance = await resolveOwnedPath(root, "provenance", {
    rejectSymlinks: true,
  });
  const info = await lstat(ownedProvenance);
  if (!info.isDirectory()) {
    throw new TypeError("provenance must be an owned directory");
  }
  return path.join(ownedProvenance, "maintenance-state");
}

export async function acceptMaintenanceUpdate({
  descriptorPath,
  sourceEffectiveFingerprint,
  diffContents,
  reviewedAt,
  evidence,
}) {
  const absoluteDescriptorPath = path.resolve(descriptorPath);
  const maintenanceLock = await maintenanceLockPath(absoluteDescriptorPath);
  const release = await acquireStateLock(maintenanceLock);
  let changedDiffPath;
  let previousDiffContents;
  let previousDiffMode;
  try {
    const descriptorMode = (await lstat(absoluteDescriptorPath)).mode & 0o777;
    const descriptor = structuredClone(await readDescriptor(absoluteDescriptorPath));
    const root = path.dirname(absoluteDescriptorPath);
    if (
      sourceEffectiveFingerprint !== undefined
      && !FINGERPRINT.test(sourceEffectiveFingerprint)
    ) {
      throw new TypeError("sourceEffectiveFingerprint must be a sha256 fingerprint");
    }
    if (sourceEffectiveFingerprint) {
      descriptor.source.effective_fingerprint = sourceEffectiveFingerprint;
    }
    if (diffContents !== undefined) {
      if (descriptor.type !== "fork") {
        throw new TypeError("diffContents is only valid for fork maintenance");
      }
      const diffPath = await resolveOwnedPath(root, descriptor.fork.diff, {
        rejectSymlinks: true,
      });
      changedDiffPath = diffPath;
      previousDiffMode = (await lstat(diffPath)).mode & 0o777;
      previousDiffContents = await readFile(diffPath);
      await writeFileAtomic(diffPath, diffContents, { mode: previousDiffMode });
    }
    descriptor.owned_payload.reviewed_fingerprint = await payloadFingerprint(root);
    if (descriptor.type === "fork") {
      const snapshotPath = await resolveOwnedPath(root, descriptor.fork.snapshot, {
        rejectSymlinks: true,
      });
      const diffPath = await resolveOwnedPath(root, descriptor.fork.diff, {
        rejectSymlinks: true,
      });
      descriptor.fork.snapshot_fingerprint = await fingerprintPath(snapshotPath);
      descriptor.fork.diff_fingerprint = await fingerprintFile(diffPath);
      if (descriptor.fork.materialization) {
        const materializationChanged =
          descriptor.fork.materialization.source_effective_fingerprint
            !== descriptor.source.effective_fingerprint
          || descriptor.fork.materialization.snapshot_fingerprint
            !== descriptor.fork.snapshot_fingerprint;
        if (
          materializationChanged
          && (reviewedAt === undefined || evidence === undefined)
        ) {
          throw new TypeError(
            "reviewedAt and evidence are required when fork materialization fingerprints change",
          );
        }
        descriptor.fork.materialization.source_effective_fingerprint =
          descriptor.source.effective_fingerprint;
        descriptor.fork.materialization.snapshot_fingerprint =
          descriptor.fork.snapshot_fingerprint;
        if (reviewedAt !== undefined) descriptor.fork.materialization.reviewed_at = reviewedAt;
        if (evidence !== undefined) descriptor.fork.materialization.evidence = evidence;
      }
    } else if (reviewedAt !== undefined || evidence !== undefined) {
      throw new TypeError("reviewedAt and evidence are only valid for fork materialization maintenance");
    }
    assertValidDescriptor(descriptor);
    await writeJsonAtomic(absoluteDescriptorPath, descriptor, {
      mode: descriptorMode,
    });
    return {
      descriptor,
      ownedPayloadFingerprint: descriptor.owned_payload.reviewed_fingerprint,
      sourceEffectiveFingerprint: descriptor.source.effective_fingerprint,
      ...(descriptor.type === "fork"
        ? {
            snapshotFingerprint: descriptor.fork.snapshot_fingerprint,
            diffFingerprint: descriptor.fork.diff_fingerprint,
          }
        : {}),
    };
  } catch (error) {
    if (changedDiffPath && previousDiffContents) {
      await writeFileAtomic(changedDiffPath, previousDiffContents, {
        mode: previousDiffMode,
      }).catch(() => {});
    }
    throw error;
  } finally {
    await release();
  }
}
