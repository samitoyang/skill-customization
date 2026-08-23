import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ingestDescriptor,
  readCheckedDescriptor,
} from "../src/descriptor.js";
import { bindCustomization } from "../src/bindings.js";
import { discoverFixtureSkills } from "./support/discovery-modes.js";
import {
  fingerprintFile,
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { preflightCustomization } from "../src/preflight.js";

const repository = "https://github.com/example/skills";

function descriptor({
  id = "urn:test:descriptor-ingestion-overlay",
  type = "semantic-overlay",
  name = "review-overlay",
  owned,
  source,
  sourceFingerprint,
  activation = { mode: "coexist" },
  fork,
}) {
  return {
    schema_version: 1,
    id,
    type,
    name,
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source: source ?? {
      skill_name: "review",
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: sourceFingerprint,
      review: { revision: "fixture" },
    },
    activation,
    ...(fork ? { fork } : {}),
  };
}

async function writeDescriptor(root, value) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

test("Descriptor ingestion returns one deeply immutable checked record", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-checked-"));
  const root = path.join(parent, "review-overlay");
  await mkdir(root);
  await writeFile(path.join(root, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(root, "CUSTOMIZATION.md"), "delta\n");
  const value = descriptor({
    owned: await payloadFingerprint(root),
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const descriptorPath = await (async () => {
    await writeDescriptor(root, value);
    return path.join(root, "customization.json");
  })();

  const result = await ingestDescriptor({ descriptorPath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.checked.artifacts.map(({ kind, type, relative }) => ({ kind, type, relative })),
    [
      { kind: "descriptor", type: "file", relative: "customization.json" },
      { kind: "entrypoint", type: "file", relative: "SKILL.md" },
      { kind: "customization", type: "file", relative: "CUSTOMIZATION.md" },
    ],
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checked), true);
  assert.equal(Object.isFrozen(result.checked.descriptor), true);
  assert.equal(Object.isFrozen(result.checked.descriptor.source), true);
  assert.throws(() => {
    result.checked.descriptor.name = "changed";
  }, TypeError);
  assert.deepEqual(
    (await readCheckedDescriptor(descriptorPath)).descriptor,
    value,
  );
});

test("Descriptor ingestion reports parse and owned-artifact diagnostics without a second reader", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-diagnostics-"));
  const descriptorPath = path.join(root, "customization.json");
  await writeFile(descriptorPath, "{not-json\n");

  const malformed = await ingestDescriptor({ descriptorPath });

  assert.equal(malformed.ok, false);
  assert.equal(malformed.checked, null);
  assert.equal(malformed.diagnostics[0].stage, "parse");
  assert.equal(malformed.diagnostics[0].code, "DESCRIPTOR_READ_ERROR");
  assert.match(malformed.diagnostics[0].message, /cannot read descriptor/);

  const customizationRoot = path.join(root, "review-overlay");
  await mkdir(customizationRoot);
  await writeFile(path.join(customizationRoot, "SKILL.md"), "dispatcher\n");
  await mkdir(path.join(customizationRoot, "CUSTOMIZATION.md"));
  const invalid = descriptor({
    owned: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  await writeDescriptor(customizationRoot, invalid);

  const unsafe = await ingestDescriptor({
    descriptorPath: path.join(customizationRoot, "customization.json"),
  });

  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.diagnostics[0].stage, "artifact");
  assert.match(unsafe.diagnostics[0].message, /invalid artifact type/);
  await assert.rejects(
    readCheckedDescriptor(path.join(customizationRoot, "customization.json")),
    /invalid artifact type/i,
  );
});

test("Descriptor ingestion checks folder identity against the canonical directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-alias-"));
  const canonicalRoot = path.join(root, "review-real");
  const aliasRoot = path.join(root, "review-alias");
  await mkdir(canonicalRoot);
  await writeFile(path.join(canonicalRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(canonicalRoot, "CUSTOMIZATION.md"), "delta\n");
  const value = descriptor({
    name: "review-alias",
    owned: await payloadFingerprint(canonicalRoot),
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  await writeDescriptor(canonicalRoot, value);
  await symlink(canonicalRoot, aliasRoot);

  const result = await ingestDescriptor({
    descriptorPath: path.join(aliasRoot, "customization.json"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].stage, "folder");
  assert.match(result.diagnostics[0].message, /does not match folder name review-real/);
});

test("a discovered customization crosses the checked Descriptor, Binding, and Preflight interfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-vertical-"));
  const sourceRoot = path.join(root, "review");
  const customizationRoot = path.join(root, "review-overlay");
  await mkdir(sourceRoot);
  await writeFile(
    path.join(sourceRoot, "SKILL.md"),
    "---\nname: review\n---\nSource workflow.\n",
  );
  await mkdir(customizationRoot);
  await writeFile(path.join(customizationRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Apply the delta.\n");
  const value = descriptor({
    owned: await payloadFingerprint(customizationRoot),
    sourceFingerprint: await fingerprintPath(sourceRoot),
  });
  await writeDescriptor(customizationRoot, value);

  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  const discovery = await discoverFixtureSkills({
    input: "review-overlay",
    roots,
    managerRecords: [],
  });
  assert.equal(discovery.groups.length, 1);
  assert.equal(discovery.groups[0].copies[0].classification, "customization");
  assert.deepEqual(discovery.groups[0].copies[0].customization, {
    id: value.id,
    type: value.type,
    license: value.license,
    reviewedPayloadFingerprint: value.owned_payload.reviewed_fingerprint,
  });

  const checked = await readCheckedDescriptor(
    path.join(customizationRoot, "customization.json"),
  );
  const statePath = path.join(root, "state", "bindings.json");
  await bindCustomization({
    descriptor: checked.descriptor,
    sourcePath: sourceRoot,
    context: "fixture",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });

  const execution = await preflightCustomization({
    descriptorPath: checked.location.descriptorPath,
    context: "fixture",
    statePath,
    roots,
  });
  assert.equal(execution.status, "ready");
  assert.deepEqual(execution.steps.map(({ role }) => role), ["workflow", "delta"]);
});

test("a discovered customization-source overlay crosses the same runtime interfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-nested-"));
  const sourceRoot = path.join(root, "review");
  const innerRoot = path.join(root, "review-inner");
  const outerRoot = path.join(root, "review-outer");
  await mkdir(sourceRoot);
  await writeFile(
    path.join(sourceRoot, "SKILL.md"),
    "---\nname: review\n---\nSource workflow.\n",
  );
  await mkdir(innerRoot);
  await writeFile(
    path.join(innerRoot, "SKILL.md"),
    "---\nname: review-inner\n---\ninner dispatcher\n",
  );
  await writeFile(path.join(innerRoot, "CUSTOMIZATION.md"), "inner delta\n");
  const inner = descriptor({
    id: "urn:test:descriptor-ingestion-inner",
    name: "review-inner",
    owned: await payloadFingerprint(innerRoot),
    sourceFingerprint: await fingerprintPath(sourceRoot),
  });
  await writeDescriptor(innerRoot, inner);
  const innerEffective = fingerprintValues(
    [
      inner.id,
      "delta",
      inner.customization,
      inner.source.effective_fingerprint,
      inner.owned_payload.reviewed_fingerprint,
    ],
    "skill-customization-overlay-effective-v1",
  );

  await mkdir(outerRoot);
  await writeFile(path.join(outerRoot, "SKILL.md"), "outer dispatcher\n");
  await writeFile(path.join(outerRoot, "CUSTOMIZATION.md"), "outer delta\n");
  const outer = descriptor({
    id: "urn:test:descriptor-ingestion-outer",
    name: "review-outer",
    owned: await payloadFingerprint(outerRoot),
    source: {
      skill_name: inner.name,
      kind: "customization",
      id: inner.id,
      type: inner.type,
      license: inner.license,
      effective_fingerprint: innerEffective,
    },
  });
  await writeDescriptor(outerRoot, outer);

  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  const discovery = await discoverFixtureSkills({
    input: outer.name,
    roots,
    managerRecords: [],
  });
  assert.equal(discovery.groups[0].copies[0].classification, "customization");

  const innerChecked = await readCheckedDescriptor(
    path.join(innerRoot, "customization.json"),
  );
  const outerChecked = await readCheckedDescriptor(
    path.join(outerRoot, "customization.json"),
  );
  const statePath = path.join(root, "state", "bindings.json");
  for (const [checked, sourcePath] of [
    [innerChecked, sourceRoot],
    [outerChecked, innerRoot],
  ]) {
    await bindCustomization({
      descriptor: checked.descriptor,
      sourcePath,
      context: "fixture",
      statePath,
      roots,
      interactive: true,
      confirm: async () => true,
    });
  }

  const execution = await preflightCustomization({
    descriptorPath: outerChecked.location.descriptorPath,
    context: "fixture",
    statePath,
    roots,
  });
  assert.equal(execution.status, "ready");
  assert.deepEqual(execution.steps.map(({ role }) => role), [
    "workflow",
    "delta",
    "delta",
  ]);
});

test("a discovered fork is readable through the checked runtime interface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-fork-"));
  const forkRoot = path.join(root, "review-fork");
  const snapshotRoot = path.join(forkRoot, "provenance", "source");
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(snapshotRoot, "SKILL.md"), "Source workflow.\n");
  await writeFile(path.join(forkRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(forkRoot, "CUSTOMIZATION.md"), "fork workflow\n");
  const diffPath = path.join(forkRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-Source workflow.\n+dispatcher\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+fork workflow\n",
  );
  const snapshotFingerprint = await fingerprintPath(snapshotRoot);
  const fork = descriptor({
    id: "urn:test:descriptor-ingestion-fork",
    type: "fork",
    name: "review-fork",
    owned: await payloadFingerprint(forkRoot),
    sourceFingerprint: snapshotFingerprint,
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  });
  await writeDescriptor(forkRoot, fork);

  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  const discovery = await discoverFixtureSkills({
    input: fork.name,
    roots,
    managerRecords: [],
  });
  assert.equal(discovery.groups[0].copies[0].classification, "customization");
  const checked = await readCheckedDescriptor(
    path.join(forkRoot, "customization.json"),
  );
  const execution = await preflightCustomization({
    descriptorPath: checked.location.descriptorPath,
    context: "fixture",
    statePath: path.join(root, "state", "bindings.json"),
    roots,
  });
  assert.equal(execution.status, "ready");
  assert.deepEqual(execution.steps.map(({ role }) => role), ["workflow"]);
});

test("an invalid descriptor file keeps Discovery's read-style diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-discovery-read-"));
  const customizationRoot = path.join(root, "review-overlay");
  await mkdir(path.join(customizationRoot, "customization.json"), { recursive: true });
  await writeFile(path.join(customizationRoot, "SKILL.md"), "dispatcher\n");

  await assert.rejects(
    discoverFixtureSkills({
      input: "review-overlay",
      roots: [{ path: root, scope: "workspace", origin: "fixture" }],
      managerRecords: [],
    }),
    (error) => {
      assert.equal(error.code, "NO_LOCAL_COPY");
      assert.match(
        error.details.candidateDiagnostics[0].message,
        /cannot read adjacent customization metadata/,
      );
      return true;
    },
  );
});

test("an invalid declared entrypoint remains a Discovery diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-entrypoint-"));
  const customizationRoot = path.join(root, "review-overlay");
  await mkdir(path.join(customizationRoot, "SKILL.md"), { recursive: true });
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  const value = descriptor({
    owned: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  await writeDescriptor(customizationRoot, value);

  await assert.rejects(
    discoverFixtureSkills({
      input: "review-overlay",
      roots: [{ path: root, scope: "workspace", origin: "fixture" }],
      managerRecords: [],
    }),
    (error) => {
      assert.equal(error.code, "NO_LOCAL_COPY");
      assert.equal(
        error.details.candidateDiagnostics[0].code,
        "MALFORMED_CUSTOMIZATION_METADATA",
      );
      assert.match(
        error.details.candidateDiagnostics[0].message, /invalid customization metadata/);
      return true;
    },
  );
});

test("Discovery recognizes a checked descriptor with a non-SKILL entrypoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-entrypoint-name-"));
  const customizationRoot = path.join(root, "review-overlay");
  await mkdir(customizationRoot);
  await writeFile(path.join(customizationRoot, "dispatcher.md"), "dispatcher\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  const value = descriptor({
    owned: await payloadFingerprint(customizationRoot),
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  value.entrypoint = "dispatcher.md";
  await writeDescriptor(customizationRoot, value);

  const discovery = await discoverFixtureSkills({
    input: "review-overlay",
    roots: [{ path: root, scope: "workspace", origin: "fixture" }],
    managerRecords: [],
  });

  assert.equal(discovery.groups[0].copies[0].classification, "customization");
});

test("unsafe discovered customization metadata remains a Discovery diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-ingestion-discovery-error-"));
  const customizationRoot = path.join(root, "review-overlay");
  const external = path.join(root, "external.md");
  await mkdir(customizationRoot);
  await writeFile(path.join(customizationRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(external, "external\n");
  await symlink(external, path.join(customizationRoot, "runtime.md"));
  const value = descriptor({
    owned: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  value.customization = "runtime.md";
  await writeDescriptor(customizationRoot, value);

  await assert.rejects(
    discoverFixtureSkills({
      input: "review-overlay",
      roots: [{ path: root, scope: "workspace", origin: "fixture" }],
      managerRecords: [],
    }),
    (error) => {
      assert.equal(error.code, "NO_LOCAL_COPY");
      assert.equal(error.details.candidateDiagnostics.length, 1);
      assert.equal(
        error.details.candidateDiagnostics[0].code,
        "MALFORMED_CUSTOMIZATION_METADATA",
      );
      assert.match(
        error.details.candidateDiagnostics[0].message,
        /invalid customization metadata/,
      );
      return true;
    },
  );
});
