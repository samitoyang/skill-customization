import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindCustomization,
  readBindingStore,
  resolveBinding,
} from "../src/bindings.js";
import { confirmDiscoverySelection } from "../src/discovery.js";
import { fingerprintPath } from "../src/fingerprint.js";
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

function descriptor(effectiveFingerprint) {
  return {
    schema_version: 1,
    id: "urn:test:ambient-plugin-binding",
    type: "semantic-overlay",
    name: "review-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: AMBIENT_PLUGIN_REPOSITORY,
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: effectiveFingerprint,
      review: { revision: "ambient-plugin" },
    },
    activation: { mode: "coexist" },
  };
}

test("ambient binding recovers a bounded plugin cache while preserving identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-ambient-recovery-"));
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
  const statePath = path.join(root, "state", "bindings.json");
  const env = ambientPluginEnvironment(root, home, claudeHome);
  const sourceDescriptor = descriptor(await fingerprintPath(versionOne));
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
    const bound = await bindCustomization({
      descriptor: sourceDescriptor,
      sourcePath: versionOne,
      context: "global",
      statePath,
      confirmedSelection,
      interactive: true,
      confirm: async () => true,
    });
    assert.equal(bound.source.pluginIdentity, AMBIENT_PLUGIN_IDENTITY);
    assert.deepEqual(bound.source.pluginCache, { kind: "versioned", scope: "global" });

    await rename(versionOneRoot, path.join(root, "removed-version-one"));
    const versionTwo = await writeAmbientPluginVersion(versionTwoRoot, "2");
    await writeAmbientInstalledPlugin(claudeHome, versionTwoRoot, "2");
    assert.equal(await fingerprintPath(versionTwo), sourceDescriptor.source.effective_fingerprint);

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

    const resolved = await resolveBinding({
      descriptor: sourceDescriptor,
      context: "global",
      statePath,
    });
    assert.equal(resolved.source.path, path.resolve(versionTwo));
    assert.equal(resolved.source.pluginIdentity, AMBIENT_PLUGIN_IDENTITY);
    assert.deepEqual(resolved.source.pluginCache, { kind: "versioned", scope: "global" });
    const key = `${encodeURIComponent(sourceDescriptor.id)}::global`;
    const persisted = (await readBindingStore(statePath)).bindings[key];
    assert.equal(persisted.source.path, path.resolve(versionTwo));
    assert.equal(persisted.source.pluginIdentity, AMBIENT_PLUGIN_IDENTITY);
  });

  assert.deepEqual({ ...process.env }, previousEnv);
  assert.equal(process.cwd(), previousCwd);
});
