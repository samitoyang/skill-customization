import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindCustomization, readBindingStore } from "../src/bindings.js";
import { confirmDiscoverySelection } from "../src/discovery.js";
import {
  fingerprintPath,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { preflightCustomization } from "../src/preflight.js";
import {
  AMBIENT_PLUGIN_IDENTITY,
  AMBIENT_PLUGIN_REPOSITORY,
  ambientDiscoveryShape,
  ambientPluginEnvironment,
  assertBoundedAmbientPluginDiscovery,
  writeAmbientInstalledPlugin,
  writeAmbientPluginVersion,
} from "./support/ambient-plugin-fixture.js";
import { discoverAmbientSkills } from "./support/discovery-modes.js";
import { withAmbientEnvironment } from "./support/ambient-environment.js";

async function writeRuntimeFiles(root, name, customization) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    `---\nname: ${name}\n---\nRun preflight and follow its checked steps.\n`,
  );
  await writeFile(path.join(root, "CUSTOMIZATION.md"), `${customization}\n`);
}

async function writeDescriptor(root, descriptor) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

function overlayDescriptor({ owned, source }) {
  return {
    schema_version: 1,
    id: "urn:test:ambient-plugin-preflight",
    type: "semantic-overlay",
    name: "review-overlay",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source,
    activation: { mode: "coexist" },
  };
}

test("ambient preflight recovers the checked workflow from a replacement plugin version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-ambient-recovery-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const claudeHome = path.join(home, ".claude");
  const versionOneRoot = path.join(
    claudeHome,
    "plugins",
    "cache",
    "fixture-marketplace",
    "reviewer",
    "1",
  );
  const versionTwoRoot = path.join(
    claudeHome,
    "plugins",
    "cache",
    "fixture-marketplace",
    "reviewer",
    "2",
  );
  const versionOne = await writeAmbientPluginVersion(versionOneRoot, "1");
  await writeAmbientInstalledPlugin(claudeHome, versionOneRoot, "1");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const customizationRoot = path.join(root, "review-overlay");
  const statePath = path.join(root, "state", "bindings.json");
  await writeRuntimeFiles(customizationRoot, "review-overlay", "Apply the overlay.");
  const descriptor = overlayDescriptor({
    owned: await payloadFingerprint(customizationRoot),
    source: {
      skill_name: "review",
      kind: "repository",
      repository: AMBIENT_PLUGIN_REPOSITORY,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: await fingerprintPath(versionOne),
      review: { revision: "ambient-plugin" },
    },
  });
  await writeDescriptor(customizationRoot, descriptor);

  const env = ambientPluginEnvironment(root, home, claudeHome);
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  await withAmbientEnvironment({ cwd, env }, async () => {
    const firstDiscovery = await discoverAmbientSkills({
      input: "review",
      home,
      cwd,
      env,
      managerRecords: [],
    });
    const repeatedDiscovery = await discoverAmbientSkills({
      input: "review",
      home,
      cwd,
      env,
      managerRecords: [],
    });
    assertBoundedAmbientPluginDiscovery(firstDiscovery, root, "1");
    assert.deepEqual(ambientDiscoveryShape(repeatedDiscovery), ambientDiscoveryShape(firstDiscovery));

    const group = firstDiscovery.groups[0];
    const copy = group.copies.find(({ pluginIdentity }) => pluginIdentity === AMBIENT_PLUGIN_IDENTITY);
    const confirmedSelection = confirmDiscoverySelection({
      discovery: firstDiscovery,
      choice: {
        name: group.name,
        fingerprint: group.fingerprint,
        path: copy.path,
        owner: copy.owner,
      },
      interactive: true,
      confirmedProvenance: `repository:${AMBIENT_PLUGIN_REPOSITORY}`,
      confirmationEvidence: {
        actor: "human",
        reason: "selected the temporary ambient plugin fixture",
      },
    });
    await bindCustomization({
      descriptor,
      sourcePath: versionOne,
      context: "global",
      statePath,
      confirmedSelection,
      interactive: true,
      confirm: async () => true,
    });

    const initial = await preflightCustomization({
      descriptorPath: path.join(customizationRoot, "customization.json"),
      context: "global",
      statePath,
    });
    assert.equal(initial.status, "ready");
    assert.equal(initial.steps[0].path, path.join(await realpath(versionOne), "SKILL.md"));
    assert.deepEqual(initial.steps.map(({ role }) => role), ["workflow", "delta"]);

    await rename(versionOneRoot, path.join(root, "removed-version-one"));
    const versionTwo = await writeAmbientPluginVersion(versionTwoRoot, "2");
    await writeAmbientInstalledPlugin(claudeHome, versionTwoRoot, "2");
    assert.equal(await fingerprintPath(versionTwo), descriptor.source.effective_fingerprint);

    const replacementDiscovery = await discoverAmbientSkills({
      input: "review",
      home,
      cwd,
      env,
      managerRecords: [],
    });
    const repeatedReplacementDiscovery = await discoverAmbientSkills({
      input: "review",
      home,
      cwd,
      env,
      managerRecords: [],
    });
    assertBoundedAmbientPluginDiscovery(replacementDiscovery, root, "2");
    assert.deepEqual(
      ambientDiscoveryShape(repeatedReplacementDiscovery),
      ambientDiscoveryShape(replacementDiscovery),
    );

    const recovered = await preflightCustomization({
      descriptorPath: path.join(customizationRoot, "customization.json"),
      context: "global",
      statePath,
    });
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.steps[0].path, path.join(await realpath(versionTwo), "SKILL.md"));
    assert.deepEqual(recovered.steps.map(({ role }) => role), ["workflow", "delta"]);
    assert.equal(recovered.effectiveFingerprint, initial.effectiveFingerprint);
    const key = `${encodeURIComponent(descriptor.id)}::global`;
    const persisted = (await readBindingStore(statePath)).bindings[key];
    assert.equal(persisted.source.path, path.resolve(versionTwo));
    assert.equal(persisted.source.pluginIdentity, AMBIENT_PLUGIN_IDENTITY);
    assert.deepEqual(persisted.source.pluginCache, { kind: "versioned", scope: "global" });
  });

  assert.deepEqual({ ...process.env }, previousEnv);
  assert.equal(process.cwd(), previousCwd);
});
