import path from "node:path";
import { readFile } from "node:fs/promises";

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

export async function acceptMaintenanceUpdate({
  descriptorPath,
  sourceEffectiveFingerprint,
  diffContents,
  reviewedAt,
  evidence,
}) {
  const absoluteDescriptorPath = path.resolve(descriptorPath);
  const maintenanceLock = path.join(
    path.dirname(absoluteDescriptorPath),
    "provenance",
    "maintenance-state",
  );
  const release = await acquireStateLock(maintenanceLock);
  let changedDiffPath;
  let previousDiffContents;
  try {
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
      previousDiffContents = await readFile(diffPath);
      await writeFileAtomic(diffPath, diffContents);
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
    await writeJsonAtomic(absoluteDescriptorPath, descriptor);
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
      await writeFileAtomic(changedDiffPath, previousDiffContents).catch(() => {});
    }
    throw error;
  } finally {
    await release();
  }
}
