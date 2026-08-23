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
  fingerprintPath,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { preflightCustomization } from "../src/preflight.js";

const repository = "https://github.com/example/skills";

function descriptor({ owned, sourceFingerprint }) {
  return {
    schema_version: 1,
    id: "urn:test:descriptor-ingestion-overlay",
    type: "semantic-overlay",
    name: "review-overlay",
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
      effective_fingerprint: sourceFingerprint,
      review: { revision: "fixture" },
    },
    activation: { mode: "coexist" },
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
