import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  stat,
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
import { preflightCustomization } from "../src/preflight.js";
import { reconcileCustomization } from "../src/reconcile.js";
import { acceptMaintenanceUpdate } from "../src/maintenance.js";

const repository = "https://github.com/example/skills";

async function writeRuntimeFiles(root, name, customization) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    `---\nname: ${name}\n---\nRun preflight and follow its checked steps.\n`,
  );
  await writeFile(path.join(root, "CUSTOMIZATION.md"), `${customization}\n`);
}

function overlayDescriptor({ id, name, owned, source }) {
  return {
    schema_version: 1,
    id,
    type: "semantic-overlay",
    name,
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source,
    activation: { mode: "coexist" },
  };
}

async function writeDescriptor(root, descriptor) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

async function recursiveFixture({
  symlinkBase = false,
  alternateInner = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-chain-"));
  const base = path.join(root, "review");
  const inner = path.join(root, "review-archive");
  const outer = path.join(root, "review-archive-notify");
  await mkdir(base);
  await writeFile(
    path.join(base, "SKILL.md"),
    "---\nname: review\n---\nBase workflow.\n",
  );
  const baseFingerprint = await fingerprintPath(base);
  const baseSource = symlinkBase ? path.join(root, "installed-review") : base;
  if (symlinkBase) await symlink(base, baseSource);

  await writeRuntimeFiles(inner, "review-archive", "Apply the archive delta.");
  if (alternateInner) {
    await writeFile(
      path.join(inner, "ALTERNATE.md"),
      "Apply an alternate reviewed delta.\n",
    );
  }
  const innerOwned = await payloadFingerprint(inner);
  const innerDescriptor = overlayDescriptor({
    id: "urn:test:review-archive",
    name: "review-archive",
    owned: innerOwned,
    source: {
      skill_name: "review",
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: baseFingerprint,
      review: { revision: "base-review" },
    },
  });
  await writeDescriptor(inner, innerDescriptor);
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

  await writeRuntimeFiles(outer, "review-archive-notify", "Apply the notification delta.");
  const outerOwned = await payloadFingerprint(outer);
  const outerDescriptor = overlayDescriptor({
    id: "urn:test:review-archive-notify",
    name: "review-archive-notify",
    owned: outerOwned,
    source: {
      skill_name: "review-archive",
      kind: "customization",
      id: innerDescriptor.id,
      type: innerDescriptor.type,
      license: innerDescriptor.license,
      effective_fingerprint: innerEffective,
    },
  });
  await writeDescriptor(outer, outerDescriptor);

  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  await bindCustomization({
    descriptor: innerDescriptor,
    sourcePath: baseSource,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  await bindCustomization({
    descriptor: outerDescriptor,
    sourcePath: inner,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  return {
    root,
    base,
    inner,
    outer,
    statePath,
    roots,
    innerDescriptor,
    innerEffective,
    outerDescriptor,
  };
}

test("owned payload fingerprints every runtime file, excludes provenance, and rejects symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "payload-fingerprint-"));
  await writeFile(path.join(root, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(root, "CUSTOMIZATION.md"), "workflow\n");
  await writeFile(path.join(root, "customization.json"), "{}\n");
  await mkdir(path.join(root, "helpers"));
  await writeFile(path.join(root, "helpers", "run.js"), "export {};\n");
  await mkdir(path.join(root, "provenance"));
  await writeFile(path.join(root, "provenance", "source.diff"), "ignored\n");
  const first = await payloadFingerprint(root);
  await writeFile(path.join(root, "customization.json"), "changed descriptor\n");
  await writeFile(path.join(root, "provenance", "source.diff"), "changed provenance\n");
  await mkdir(path.join(root, "helpers", ".GiT"));
  await writeFile(path.join(root, "helpers", ".GiT", "HEAD"), "clone-local\n");
  assert.equal(await payloadFingerprint(root), first);
  await writeFile(path.join(root, "helpers", "run.js"), "export const changed = true;\n");
  assert.notEqual(await payloadFingerprint(root), first);
  await symlink(path.join(root, "SKILL.md"), path.join(root, "helpers", "linked.md"));
  await assert.rejects(payloadFingerprint(root), /symbolic link/i);
});

test("preflight flattens recursive overlays from base workflow through inner and outer deltas", async () => {
  const item = await recursiveFixture({ symlinkBase: true });
  const [base, inner, outer] = await Promise.all([
    realpath(item.base),
    realpath(item.inner),
    realpath(item.outer),
  ]);
  const result = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  assert.equal(result.status, "ready");
  assert.match(result.effectiveFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    result.steps.map(({ role, path: stepPath, customizationId }) => ({
      role,
      path: stepPath,
      customizationId,
    })),
    [
      { role: "workflow", path: path.join(base, "SKILL.md"), customizationId: null },
      { role: "delta", path: path.join(inner, "CUSTOMIZATION.md"), customizationId: "urn:test:review-archive" },
      { role: "delta", path: path.join(outer, "CUSTOMIZATION.md"), customizationId: "urn:test:review-archive-notify" },
    ],
  );
  assert.equal(result.maintenanceHandler, null);
});

test("reconciliation uses a nested customization's checked effective fingerprint", async () => {
  const item = await recursiveFixture();
  assert.notEqual(await fingerprintPath(item.inner), item.innerEffective);

  await assert.rejects(
    reconcileCustomization({
      descriptor: item.outerDescriptor,
      customizationRoot: item.outer,
      sourcePath: item.inner,
      cachePath: null,
    }),
    (error) => error.code === "CUSTOMIZATION_SOURCE_EFFECTIVE_FINGERPRINT_REQUIRED",
  );

  const result = await reconcileCustomization({
    descriptor: item.outerDescriptor,
    customizationRoot: item.outer,
    sourcePath: item.inner,
    sourceEffectiveFingerprint: item.innerEffective,
    cachePath: null,
  });
  assert.equal(result.status, "compatible");
  assert.equal(result.sourceFingerprint, item.innerEffective);
  assert.equal(result.checkpointMatch, true);
});

test("semantic reconciliation receives the checked nested execution plan", async () => {
  const item = await recursiveFixture();
  const nested = await preflightCustomization({
    descriptorPath: path.join(item.inner, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  assert.equal(nested.status, "ready");

  const descriptor = structuredClone(item.outerDescriptor);
  descriptor.source.effective_fingerprint =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const options = {
    descriptor,
    customizationRoot: item.outer,
    sourcePath: item.inner,
    sourceEffectiveFingerprint: nested.effectiveFingerprint,
    cachePath: null,
    semanticReconciler: async () => ({
      compatible: true,
      evidence: "Reviewed the checked nested execution plan.",
    }),
  };
  await assert.rejects(
    reconcileCustomization(options),
    (error) => error.code === "CUSTOMIZATION_SOURCE_EXECUTION_PLAN_REQUIRED",
  );

  let received;
  const result = await reconcileCustomization({
    ...options,
    sourceExecutionPlan: nested.steps,
    semanticReconciler: async (input) => {
      received = input;
      return {
        compatible: true,
        evidence: "Reviewed the checked nested execution plan.",
      };
    },
  });
  assert.equal(result.status, "compatible");
  assert.equal(received.sourceEntrypoint, nested.steps[0].path);
  assert.deepEqual(received.sourceExecutionPlan, nested.steps);
  assert.deepEqual(
    received.sourceExecutionPlan.map(({ role }) => role),
    ["workflow", "delta"],
  );
});

test("preflight rejects source-internal symlinks before returning executable steps", async () => {
  const item = await recursiveFixture();
  const external = path.join(item.root, "shared-workflow.md");
  await writeFile(external, "---\nname: review\n---\nunreviewed shared workflow\n");
  await unlink(path.join(item.base, "SKILL.md"));
  await symlink(external, path.join(item.base, "SKILL.md"));

  const result = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });

  assert.equal(result.status, "maintenance-required");
  assert.equal(result.maintenanceHandler.reason, "binding-maintenance");
  assert.match(result.maintenanceHandler.detail, /symbolic link.*SKILL\.md/i);
  assert.deepEqual(result.steps, []);
});

test("preflight excludes clone-local Git metadata from full-source checkpoints", async () => {
  const item = await recursiveFixture();
  const gitMetadata = path.join(item.base, ".GiT");
  await mkdir(path.join(gitMetadata, "refs"), { recursive: true });
  await writeFile(path.join(gitMetadata, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitMetadata, "index"), "clone-local index\n");

  const first = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  await writeFile(path.join(gitMetadata, "HEAD"), "ref: refs/heads/other\n");
  const second = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.equal(second.effectiveFingerprint, first.effectiveFingerprint);
});

test("effective fingerprints bind the selected reviewed execution file", async () => {
  const item = await recursiveFixture({ alternateInner: true });
  item.innerDescriptor.customization = "ALTERNATE.md";
  await writeDescriptor(item.inner, item.innerDescriptor);

  const result = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });

  assert.equal(result.status, "maintenance-required");
  assert.equal(result.maintenanceHandler.reason, "source-drift");
  assert.equal(result.maintenanceHandler.customizationId, "urn:test:review-archive-notify");
});

test("preflight propagates an inner owned-payload stop with one maintenance handler", async () => {
  const item = await recursiveFixture();
  await writeFile(path.join(item.inner, "CUSTOMIZATION.md"), "Unreviewed direct edit.\n");
  const result = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  assert.equal(result.status, "maintenance-required");
  assert.equal(result.maintenanceHandler.skill, "skill-overlay");
  assert.equal(result.maintenanceHandler.customizationId, "urn:test:review-archive");
  assert.equal(result.maintenanceHandler.reason, "owned-payload-drift");
  assert.deepEqual(result.steps, []);
});

test("an accepted maintenance update refreshes reviewed fingerprints before preflight reruns", async () => {
  const item = await recursiveFixture();
  await writeFile(path.join(item.outer, "CUSTOMIZATION.md"), "Reviewed replacement delta.\n");
  const accepted = await acceptMaintenanceUpdate({
    descriptorPath: path.join(item.outer, "customization.json"),
  });
  assert.equal(
    accepted.ownedPayloadFingerprint,
    await payloadFingerprint(item.outer),
  );
  const result = await preflightCustomization({
    descriptorPath: path.join(item.outer, "customization.json"),
    context: "workspace:test",
    statePath: item.statePath,
    roots: item.roots,
  });
  assert.equal(result.status, "ready");
});

test("maintenance rejects a provenance symlink before acquiring its lock", async () => {
  const item = await recursiveFixture();
  const external = path.join(item.root, "external-provenance");
  await mkdir(external);
  await symlink(external, path.join(item.outer, "provenance"));

  await assert.rejects(
    acceptMaintenanceUpdate({
      descriptorPath: path.join(item.outer, "customization.json"),
    }),
    /symbolic link.*provenance|provenance.*outside/i,
  );
});

test("materialization fingerprint changes require fresh review evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "materialization-maintenance-"));
  const forkRoot = path.join(root, "review-standalone");
  const snapshot = path.join(forkRoot, "provenance", "source");
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, "SKILL.md"), "materialized workflow\n");
  await writeFile(path.join(forkRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(forkRoot, "CUSTOMIZATION.md"), "independent workflow\n");
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(diffPath, "reviewed materialization diff\n");
  const sourceFingerprint =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:review-standalone-materialized",
    type: "fork",
    name: "review-standalone",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(forkRoot) },
    source: {
      skill_name: "review-archive",
      kind: "customization",
      id: "urn:test:review-archive",
      type: "semantic-overlay",
      license: "MIT",
      effective_fingerprint: sourceFingerprint,
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
      materialization: {
        source_effective_fingerprint: sourceFingerprint,
        snapshot_fingerprint: snapshotFingerprint,
        reviewed_at: "2026-08-09T00:00:00Z",
        evidence: "Reviewed the original materialization.",
      },
    },
  };
  const descriptorPath = path.join(forkRoot, "customization.json");
  await writeDescriptor(forkRoot, descriptor);
  await chmod(descriptorPath, 0o644);
  await chmod(diffPath, 0o640);
  const changedSourceFingerprint =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  await assert.rejects(
    acceptMaintenanceUpdate({
      descriptorPath,
      sourceEffectiveFingerprint: changedSourceFingerprint,
      diffContents: "unaccepted materialization diff\n",
    }),
    /reviewedAt and evidence are required/i,
  );
  await assert.rejects(
    acceptMaintenanceUpdate({
      descriptorPath,
      reviewedAt: "2026-08-10T00:00:00Z",
    }),
    /reviewedAt and evidence must be supplied together/i,
  );
  assert.deepEqual(
    JSON.parse(await readFile(descriptorPath, "utf8")),
    descriptor,
  );
  assert.equal(
    await readFile(diffPath, "utf8"),
    "reviewed materialization diff\n",
  );

  const accepted = await acceptMaintenanceUpdate({
    descriptorPath,
    sourceEffectiveFingerprint: changedSourceFingerprint,
    diffContents: "updated reviewed materialization diff\n",
    reviewedAt: "2026-08-10T00:00:00Z",
    evidence: "Reviewed the updated materialization.",
  });
  assert.deepEqual(accepted.descriptor.fork.materialization, {
    source_effective_fingerprint: changedSourceFingerprint,
    snapshot_fingerprint: snapshotFingerprint,
    reviewed_at: "2026-08-10T00:00:00Z",
    evidence: "Reviewed the updated materialization.",
  });
  assert.match(
    accepted.descriptor.fork.diff,
    /^provenance\/diffs\/[0-9a-f]{64}\.diff$/,
  );
  assert.equal(
    await readFile(path.join(forkRoot, accepted.descriptor.fork.diff), "utf8"),
    "updated reviewed materialization diff\n",
  );
  assert.equal(
    await readFile(diffPath, "utf8"),
    "reviewed materialization diff\n",
  );
  const committed = JSON.parse(await readFile(descriptorPath, "utf8"));
  const committedDiffPath = path.join(forkRoot, committed.fork.diff);
  assert.equal(committed.fork.diff, accepted.descriptor.fork.diff);
  assert.equal(
    committed.fork.diff_fingerprint,
    await fingerprintFile(committedDiffPath),
  );
  assert.equal(accepted.diffFingerprint, committed.fork.diff_fingerprint);
  assert.equal((await stat(descriptorPath)).mode & 0o777, 0o644);
  assert.equal(
    (await stat(committedDiffPath)).mode & 0o777,
    0o640,
  );
});

test("preflight detects recursive customization cycles by stable ID and canonical path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-cycle-"));
  const firstRoot = path.join(root, "first-overlay");
  const secondRoot = path.join(root, "second-overlay");
  await writeRuntimeFiles(firstRoot, "first-overlay", "First delta.");
  await writeRuntimeFiles(secondRoot, "second-overlay", "Second delta.");
  const first = overlayDescriptor({
    id: "urn:test:first-overlay",
    name: "first-overlay",
    owned: await payloadFingerprint(firstRoot),
    source: {
      skill_name: "second-overlay",
      kind: "customization",
      id: "urn:test:second-overlay",
      type: "semantic-overlay",
      license: "MIT",
      effective_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
  const second = overlayDescriptor({
    id: "urn:test:second-overlay",
    name: "second-overlay",
    owned: await payloadFingerprint(secondRoot),
    source: {
      skill_name: "first-overlay",
      kind: "customization",
      id: "urn:test:first-overlay",
      type: "semantic-overlay",
      license: "MIT",
      effective_fingerprint:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
  await writeDescriptor(firstRoot, first);
  await writeDescriptor(secondRoot, second);
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  for (const [descriptor, sourcePath] of [
    [first, secondRoot],
    [second, firstRoot],
  ]) {
    await bindCustomization({
      descriptor,
      sourcePath,
      context: "workspace:test",
      statePath,
      roots,
      interactive: true,
      confirm: async () => true,
    });
  }
  const result = await preflightCustomization({
    descriptorPath: path.join(firstRoot, "customization.json"),
    context: "workspace:test",
    statePath,
    roots,
  });
  assert.equal(result.status, "maintenance-required");
  assert.equal(result.maintenanceHandler.reason, "cycle-detected");
  assert.equal(result.maintenanceHandler.customizationId, first.id);
});

test("verified forks are runtime leaves and execute their complete independent workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-fork-"));
  const forkRoot = path.join(root, "review-standalone");
  const snapshot = path.join(forkRoot, "provenance", "source");
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
    roots: [{ path: trackedSkills, scope: "workspace", origin: "fixture" }],
    interactive: true,
    confirm: async () => true,
  });
  await writeFile(
    path.join(trackedSource, "SKILL.md"),
    "---\nname: review\n---\nTracked source drift.\n",
  );
  const advisory = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:tracked",
    statePath: trackingState,
  });
  assert.equal(advisory.status, "ready-with-advisory");
  assert.equal(advisory.advisories[0].code, "tracking-source-drift");
  assert.deepEqual(advisory.steps, result.steps);

  await writeFile(trackingState, "{\n");
  const invalidTrackingState = await preflightCustomization({
    descriptorPath: path.join(forkRoot, "customization.json"),
    context: "workspace:tracked",
    statePath: trackingState,
  });
  assert.equal(invalidTrackingState.status, "ready-with-advisory");
  assert.equal(invalidTrackingState.advisories[0].code, "tracking-state-invalid");
  assert.deepEqual(invalidTrackingState.steps, result.steps);
});
