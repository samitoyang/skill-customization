import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindCustomization, resolveBinding } from "../src/bindings.js";
import { main } from "../src/cli.js";
import { readDescriptor, validateDescriptor } from "../src/descriptor.js";
import { renderDispatcher } from "../src/dispatcher-renderer.js";
import {
  fingerprintFile,
  fingerprintPath,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { generateLocalIdentity } from "../src/normalization.js";
import { preflightCustomization } from "../src/preflight.js";

async function renderFromConfirmedInputs(type, metadata, options) {
  let stdout = "";
  let stderr = "";
  const code = await main(
    ["render-dispatcher", type, ...options],
    {
      stdin: { isTTY: false },
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    },
  );
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(stdout, renderDispatcher(type, metadata));
  return stdout;
}

async function localSource(root, name, workflow) {
  await mkdir(root, { recursive: true });
  const entrypoint = path.join(root, "SKILL.md");
  await writeFile(entrypoint, workflow);
  const entrypointFingerprint = await fingerprintFile(entrypoint);
  return {
    skill_name: name,
    kind: "local",
    license: "MIT",
    identity: generateLocalIdentity({
      skillName: name,
      fingerprint: entrypointFingerprint,
    }),
    effective_fingerprint: await fingerprintPath(root),
  };
}

async function writeDescriptor(root, descriptor) {
  const descriptorPath = path.join(root, "customization.json");
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  assert.deepEqual(validateDescriptor(descriptor), []);
  assert.deepEqual(await readDescriptor(descriptorPath), descriptor);
  return descriptorPath;
}

function patchLines(contents) {
  assert.ok(contents.endsWith("\n"));
  return contents.slice(0, -1).split("\n");
}

function replaceFilePatch(relativePath, before, after) {
  const oldLines = patchLines(before);
  const newLines = patchLines(after);
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function addFilePatch(relativePath, contents) {
  const newLines = patchLines(contents);
  return [
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${newLines.length} @@`,
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

test("confirmed overlay creation renders canonically and preflights a decision-changing delta", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "creation-overlay-"));
  const sourcesRoot = path.join(temporary, "sources");
  const sourceRoot = path.join(sourcesRoot, "deploy");
  const customizationRoot = path.join(temporary, "skills", "deploy-preview-canary");
  const sourceWorkflow = `---
name: deploy
---

# Deploy

1. Choose the stable channel for a preview deployment.
2. Deploy the chosen channel.
`;
  const delta = `# Preview channel delta

Before deployment action, replace the source channel decision for previews:
choose the canary channel instead of the stable channel.
`;
  const source = await localSource(sourceRoot, "deploy", sourceWorkflow);
  await mkdir(customizationRoot, { recursive: true });

  const metadata = {
    name: "deploy-preview-canary",
    description: "Deploy previews through the canary channel.",
    license: "MIT",
    metadata: { owner: "release-engineering" },
  };
  const dispatcher = await renderFromConfirmedInputs(
    "semantic-overlay",
    metadata,
    [
      "--name", metadata.name,
      "--description", metadata.description,
      "--license", metadata.license,
      "--metadata", "owner=release-engineering",
    ],
  );
  await writeFile(path.join(customizationRoot, "SKILL.md"), dispatcher);
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), delta);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:deploy-preview-canary",
    type: "semantic-overlay",
    name: metadata.name,
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    source,
    activation: { mode: "coexist" },
  };
  const descriptorPath = await writeDescriptor(customizationRoot, descriptor);
  const context = "workspace:creation-test";
  const statePath = path.join(temporary, "state", "bindings.json");
  const roots = [{ path: sourcesRoot, scope: "workspace", origin: "fixture" }];
  await bindCustomization({
    descriptor,
    sourcePath: sourceRoot,
    context,
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });

  assert.equal(
    await readFile(path.join(customizationRoot, "SKILL.md"), "utf8"),
    renderDispatcher("semantic-overlay", metadata),
  );
  assert.doesNotMatch(dispatcher, /npx|@latest|\/workspace\/|creation-test/);
  assert.match(dispatcher, /skill-customization supports 2/);
  assert.doesNotMatch(dispatcher, /skill-customization supports 1/);
  assert.equal(
    (await resolveBinding({ descriptor, context, statePath, roots })).source.path,
    sourceRoot,
  );

  const preflight = await preflightCustomization({
    descriptorPath,
    context,
    statePath,
    roots,
  });
  assert.equal(preflight.status, "ready");
  assert.deepEqual(preflight.steps.map(({ role }) => role), ["workflow", "delta"]);
  const completePlan = await Promise.all(
    preflight.steps.map((step) => readFile(step.path, "utf8")),
  );
  assert.deepEqual(completePlan, [sourceWorkflow, delta]);
  assert.match(completePlan[0], /Choose the stable channel/);
  assert.match(completePlan[1], /replace the source channel decision/);
  assert.match(completePlan[1], /canary channel instead of the stable channel/);
  assert.match(dispatcher, /load the complete plan, then compose its workflow/);
  assert.match(dispatcher, /execute only the effective workflow/);
});

test("confirmed fork creation renders canonically and preflights without a live source", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "creation-fork-"));
  const customizationRoot = path.join(temporary, "skills", "review-independent");
  const snapshotRoot = path.join(customizationRoot, "provenance", "source");
  await mkdir(snapshotRoot, { recursive: true });
  const sourceWorkflow = `---
name: review
---

# Review

Review the change using the source checkout.
`;
  const independentWorkflow = `# Independent review workflow

1. Inspect the supplied change.
2. Record the findings in the requested output.
`;
  const snapshotEntrypoint = path.join(snapshotRoot, "SKILL.md");
  await writeFile(snapshotEntrypoint, sourceWorkflow);

  const metadata = {
    name: "review-independent",
    description: "Review changes with an independent workflow.",
    license: "MIT",
  };
  const dispatcher = await renderFromConfirmedInputs("fork", metadata, [
    "--name", metadata.name,
    "--description", metadata.description,
    "--license", metadata.license,
  ]);
  await writeFile(path.join(customizationRoot, "SKILL.md"), dispatcher);
  await writeFile(
    path.join(customizationRoot, "CUSTOMIZATION.md"),
    independentWorkflow,
  );
  const diffPath = path.join(customizationRoot, "provenance", "source.diff");
  await writeFile(
    diffPath,
    replaceFilePatch("SKILL.md", sourceWorkflow, dispatcher)
      + addFilePatch("CUSTOMIZATION.md", independentWorkflow),
  );
  const snapshotFingerprint = await fingerprintPath(snapshotRoot);
  const snapshotEntrypointFingerprint = await fingerprintFile(snapshotEntrypoint);
  const descriptor = {
    schema_version: 1,
    id: "urn:test:review-independent",
    type: "fork",
    name: metadata.name,
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      identity: generateLocalIdentity({
        skillName: "review",
        fingerprint: snapshotEntrypointFingerprint,
      }),
      effective_fingerprint: snapshotFingerprint,
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  const descriptorPath = await writeDescriptor(customizationRoot, descriptor);

  assert.equal(
    await readFile(path.join(customizationRoot, "SKILL.md"), "utf8"),
    renderDispatcher("fork", metadata),
  );
  assert.doesNotMatch(dispatcher, /npx|@latest|\/workspace\//);
  assert.match(dispatcher, /skill-customization supports 2/);
  assert.doesNotMatch(dispatcher, /skill-customization supports 1/);
  const preflight = await preflightCustomization({
    descriptorPath,
    context: "workspace:creation-test",
    statePath: path.join(temporary, "state", "bindings.json"),
  });
  assert.equal(preflight.status, "ready");
  assert.deepEqual(preflight.advisories, []);
  const canonicalCustomizationRoot = await realpath(customizationRoot);
  assert.deepEqual(preflight.steps, [{
    role: "workflow",
    path: path.join(canonicalCustomizationRoot, "CUSTOMIZATION.md"),
    root: canonicalCustomizationRoot,
    customizationId: descriptor.id,
  }]);
  assert.equal(await readFile(preflight.steps[0].path, "utf8"), independentWorkflow);
});
