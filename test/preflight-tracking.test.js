import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
    sourcePath: inner,
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
});
