import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindCustomization } from "../src/bindings.js";
import {
  fingerprintFile,
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { acceptMaintenanceUpdate } from "../src/maintenance.js";
import { preflightCustomization } from "../src/preflight.js";

const repository = "https://github.com/example/skills";

async function writeDescriptor(root, descriptor) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

async function writeRuntimeFiles(root, name, customization) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    `---\nname: ${name}\n---\nRun preflight and follow its checked steps.\n`,
  );
  await writeFile(path.join(root, "CUSTOMIZATION.md"), `${customization}\n`);
}

test("fork tracking compares a customization source by checked effective fingerprint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-tracking-customization-"));
  const base = path.join(root, "review");
  const inner = path.join(root, "review-archive");
  const innerAlias = path.join(root, "installed-review-archive");
  const replacementInner = path.join(root, "replacement", "review-archive");
  const forkRoot = path.join(root, "review-archive-standalone");
  const snapshot = path.join(forkRoot, "provenance", "source");
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];

  await mkdir(base);
  await writeFile(
    path.join(base, "SKILL.md"),
    "---\nname: review\n---\nBase workflow.\n",
  );
  const baseFingerprint = await fingerprintPath(base);

  await writeRuntimeFiles(inner, "review-archive", "Apply the archive delta.");
  const innerOwned = await payloadFingerprint(inner);
  const innerDescriptor = {
    schema_version: 1,
    id: "urn:test:tracking-review-archive",
    type: "semantic-overlay",
    name: "review-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: innerOwned },
    source: {
      skill_name: "review",
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: baseFingerprint,
      review: { revision: "tracking-base-review" },
    },
    activation: { mode: "coexist" },
  };
  await writeDescriptor(inner, innerDescriptor);
  await symlink(inner, innerAlias, "dir");
  const innerEffective = fingerprintValues(
    [
      innerDescriptor.id,
      "delta",
      innerDescriptor.customization,
      baseFingerprint,
      innerOwned,
    ],
    "skill-customization-overlay-effective-v1",
  );

  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, "SKILL.md"), "materialized inner workflow\n");
  await writeFile(path.join(forkRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(
    path.join(forkRoot, "CUSTOMIZATION.md"),
    "complete independent workflow\n",
  );
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-materialized inner workflow\n+dispatcher\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+complete independent workflow\n",
  );
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const forkDescriptor = {
    schema_version: 1,
    id: "urn:test:tracking-review-archive-standalone",
    type: "fork",
    name: "review-archive-standalone",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(forkRoot) },
    source: {
      skill_name: innerDescriptor.name,
      kind: "customization",
      id: innerDescriptor.id,
      type: innerDescriptor.type,
      license: innerDescriptor.license,
      effective_fingerprint: innerEffective,
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
      materialization: {
        source_effective_fingerprint: innerEffective,
        snapshot_fingerprint: snapshotFingerprint,
        reviewed_at: "2026-08-10T00:00:00Z",
        evidence: "Reviewed the tracked customization materialization.",
      },
    },
  };
  await writeDescriptor(forkRoot, forkDescriptor);

  await bindCustomization({
    descriptor: innerDescriptor,
    sourcePath: base,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  await bindCustomization({
    descriptor: forkDescriptor,
    sourcePath: innerAlias,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });

  const rawInnerFingerprint = await fingerprintPath(inner);
  const before = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:test",
    statePath,
    roots,
  });
  assert.equal(before.status, "ready");
  assert.deepEqual(before.advisories, []);

  await writeFile(
    path.join(base, "SKILL.md"),
    "---\nname: review\n---\nChanged base workflow.\n",
  );
  assert.equal(await fingerprintPath(inner), rawInnerFingerprint);

  const after = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:test",
    statePath,
    roots,
  });
  assert.equal(after.status, "ready-with-advisory");
  assert.equal(after.advisories.length, 1);
  assert.equal(after.advisories[0].code, "tracking-source-drift");
  assert.equal(after.advisories[0].expectedFingerprint, innerEffective);

  await writeFile(
    path.join(base, "SKILL.md"),
    "---\nname: review\n---\nBase workflow.\n",
  );
  await cp(inner, replacementInner, { recursive: true });
  await unlink(innerAlias);
  await symlink(replacementInner, innerAlias, "dir");
  const retargeted = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:test",
    statePath,
    roots,
  });
  assert.equal(retargeted.status, "ready-with-advisory");
  assert.equal(retargeted.advisories[0].code, "tracking-binding-invalid");
  assert.match(retargeted.advisories[0].detail, /retargeted/i);
});

test("fork tracking validates repository binding canonical targets before drift comparison", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-tracking-binding-"));
  const sources = path.join(root, "sources");
  const original = path.join(sources, "review-original");
  const replacement = path.join(sources, "review-replacement");
  const alias = path.join(sources, "review");
  const forkRoot = path.join(root, "review-fork");
  const snapshot = path.join(forkRoot, "provenance", "source");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, "SKILL.md"), "---\nname: review\n---\nWorkflow.\n");
  await symlink(original, alias, "dir");
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, "SKILL.md"), "---\nname: review\n---\nWorkflow.\n");
  await writeRuntimeFiles(forkRoot, "review-fork", "Independent workflow.");
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,4 +1,4 @@\n ---\n-name: review\n+name: review-fork\n ---\n-Workflow.\n+Run preflight and follow its checked steps.\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+Independent workflow.\n",
  );
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:tracking-binding-validation",
    type: "fork",
    name: "review-fork",
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
      review: { revision: "tracking-binding-review" },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  await writeDescriptor(forkRoot, descriptor);
  const roots = [{ path: sources, scope: "workspace", origin: "fixture" }];
  await bindCustomization({
    descriptor,
    sourcePath: alias,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });

  await mkdir(replacement);
  await writeFile(path.join(replacement, "SKILL.md"), "---\nname: review\n---\nWorkflow.\n");
  await unlink(alias);
  await symlink(replacement, alias, "dir");
  const result = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:test",
    statePath,
    roots,
  });

  assert.equal(result.status, "ready-with-advisory");
  assert.equal(result.advisories[0].code, "tracking-binding-invalid");
  assert.match(result.advisories[0].detail, /retargeted/i);
});

test("verified forks are runtime leaves and execute their complete independent workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-fork-"));
  const forkRoot = path.join(root, "review-standalone");
  const snapshot = path.join(forkRoot, "provenance", "source");
  const fixtureRoots = [{ path: root, scope: "workspace", origin: "fixture" }];
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, "SKILL.md"), "source\n");
  await writeFile(path.join(forkRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(forkRoot, "CUSTOMIZATION.md"), "complete workflow\n");
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-source\n+dispatcher\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+complete workflow\n",
  );
  const owned = await payloadFingerprint(forkRoot);
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:review-standalone",
    type: "fork",
    name: "review-standalone",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source: {
      skill_name: "review",
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: { revision: "fork-review" },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  await writeDescriptor(forkRoot, descriptor);
  const descriptorPath = path.join(forkRoot, "customization.json");
  const result = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath: path.join(root, "state", "bindings.json"),
    roots: fixtureRoots,
    managerRecords: [],
  });
  const canonicalForkRoot = await realpath(forkRoot);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.steps, [{
    role: "workflow",
    path: path.join(canonicalForkRoot, "CUSTOMIZATION.md"),
    root: canonicalForkRoot,
    customizationId: descriptor.id,
  }]);
  assert.deepEqual(result.advisories, []);
  const changedSourceFingerprint =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await assert.rejects(
    acceptMaintenanceUpdate({
      descriptorPath,
      sourceEffectiveFingerprint: changedSourceFingerprint,
    }),
    /full-source snapshot.*source checkpoint/i,
  );
  assert.deepEqual(JSON.parse(await readFile(descriptorPath, "utf8")), descriptor);
  await assert.rejects(
    acceptMaintenanceUpdate({
      descriptorPath,
      reviewedAt: "2026-08-10T00:00:00Z",
      evidence: "This full-source fork has no materialization record.",
    }),
    /only valid for fork materialization maintenance/i,
  );

  const trackedSkills = path.join(root, "tracked-skills");
  const trackedSource = path.join(trackedSkills, "review");
  const trackingRoots = [{ path: trackedSkills, scope: "workspace", origin: "fixture" }];
  await mkdir(trackedSource, { recursive: true });
  await writeFile(
    path.join(trackedSource, "SKILL.md"),
    "---\nname: review\n---\nTracked source.\n",
  );
  const trackingState = path.join(root, "state", "tracking-bindings.json");
  await bindCustomization({
    descriptor,
    sourcePath: trackedSource,
    context: "workspace:tracked",
    statePath: trackingState,
    roots: trackingRoots,
    managerRecords: [],
    interactive: true,
    confirm: async () => true,
  });
  await writeFile(
    path.join(trackedSource, "SKILL.md"),
    "---\nname: review\n---\nTracked source drift.\n",
  );
  const advisory = await preflightCustomization({
    descriptorPath,
    context: "workspace:tracked",
    statePath: trackingState,
    roots: trackingRoots,
    managerRecords: [],
  });
  assert.equal(advisory.status, "ready-with-advisory");
  assert.equal(advisory.advisories[0].code, "tracking-source-drift");
  assert.deepEqual(advisory.steps, result.steps);

  await writeFile(trackingState, "{\n");
  const invalidTrackingState = await preflightCustomization({
    descriptorPath,
    context: "workspace:tracked",
    statePath: trackingState,
    roots: trackingRoots,
    managerRecords: [],
  });
  assert.equal(invalidTrackingState.status, "ready-with-advisory");
  assert.equal(invalidTrackingState.advisories[0].code, "tracking-state-invalid");
  assert.deepEqual(invalidTrackingState.steps, result.steps);
});
