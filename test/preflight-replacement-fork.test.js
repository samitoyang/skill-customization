import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindCustomization } from "../src/bindings.js";
import { fingerprintFile, fingerprintPath, payloadFingerprint } from "../src/fingerprint.js";
import { preflightCustomization } from "../src/preflight.js";

const repository = "https://github.com/example/skills";

async function writeDescriptor(root, descriptor) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

test("replacement forks require a confirmed unambiguous context binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-replacement-fork-"));
  const sourceRoot = path.join(root, "review");
  const forkRoot = path.join(root, "review-fork");
  const snapshotRoot = path.join(forkRoot, "provenance", "source");
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  const sourceContents = "---\nname: review\n---\nSource workflow.\n";

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "SKILL.md"), sourceContents);
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(snapshotRoot, "SKILL.md"), sourceContents);
  await writeFile(path.join(forkRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(forkRoot, "CUSTOMIZATION.md"), "replacement workflow\n");
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,4 +1 @@\n----\n-name: review\n----\n-Source workflow.\n+dispatcher\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+replacement workflow\n",
  );

  const snapshotFingerprint = await fingerprintPath(snapshotRoot);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:replacement-review-fork",
    type: "fork",
    name: "review",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(forkRoot) },
    source: {
      skill_name: "review",
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: { revision: "replacement-review" },
    },
    activation: {
      mode: "replace",
      precedence: "customization-first",
    },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  await writeDescriptor(forkRoot, descriptor);
  const descriptorPath = path.join(forkRoot, "customization.json");
  const oneActiveSource = [{ name: "review", path: sourceRoot }];

  const unconfirmed = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath,
    roots,
    activeSkills: oneActiveSource,
  });
  assert.equal(unconfirmed.status, "maintenance-required");
  assert.equal(unconfirmed.maintenanceHandler.reason, "binding-maintenance");
  assert.deepEqual(unconfirmed.steps, []);

  await bindCustomization({
    descriptor,
    sourcePath: sourceRoot,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
    confirmReplace: async () => true,
    activeSkills: oneActiveSource,
  });

  const ambiguous = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath,
    roots,
    activeSkills: [
      ...oneActiveSource,
      { name: "review", path: path.join(root, "other-review") },
    ],
  });
  assert.equal(ambiguous.status, "maintenance-required");
  assert.equal(ambiguous.maintenanceHandler.reason, "binding-maintenance");
  assert.match(ambiguous.maintenanceHandler.detail, /ambiguous/i);
  assert.deepEqual(ambiguous.steps, []);

  const confirmed = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath,
    roots,
    activeSkills: oneActiveSource,
  });
  assert.equal(confirmed.status, "ready");
  assert.deepEqual(confirmed.advisories, []);
  assert.equal(confirmed.steps.length, 1);
  assert.equal(confirmed.steps[0].role, "workflow");
  assert.equal(confirmed.steps[0].customizationId, descriptor.id);
});
