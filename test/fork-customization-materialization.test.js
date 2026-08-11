import assert from "node:assert/strict";
import test from "node:test";

import { validateDescriptor } from "../src/descriptor.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const snapshotFingerprint = `sha256:${"b".repeat(64)}`;
const diffFingerprint = `sha256:${"c".repeat(64)}`;

test("fork-from-fork customization sources require reviewed materialization", () => {
  const descriptor = {
    schema_version: 1,
    id: "urn:test:fork-from-fork",
    type: "fork",
    name: "review-fork",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: fingerprint },
    source: {
      skill_name: "review-source",
      kind: "customization",
      id: "urn:test:review-source",
      type: "fork",
      license: "MIT",
      effective_fingerprint: fingerprint,
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: diffFingerprint,
    },
  };

  assert.ok(validateDescriptor(descriptor).some(
    ({ path: pointer }) => pointer === "/fork/materialization",
  ));

  descriptor.fork.materialization = {
    source_effective_fingerprint: fingerprint,
    snapshot_fingerprint: snapshotFingerprint,
    reviewed_at: "2026-08-11T00:00:00Z",
    evidence: "Reviewed the fork workflow materialization.",
  };
  assert.deepEqual(validateDescriptor(descriptor), []);
});
