import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindCustomization,
  bindingKey,
  bindingStorePath,
  classifyBindingScope,
  readBindingStore,
  resolveBinding,
  validateBinding,
} from "../src/bindings.js";
import {
  fingerprintFile,
  fingerprintPath,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { generateLocalIdentity } from "../src/normalization.js";
import { preflightCustomization } from "../src/preflight.js";
import { inspectCustomizationExecution } from "../src/execution-graph.js";
import { createBindingRuntime } from "../src/internal/binding-runtime.js";
import { confirmDiscoverySelection } from "../src/discovery.js";
import { discoverFixtureSkills } from "./support/discovery-modes.js";
import { acquireStateLock } from "../src/state.js";

function descriptor(activation = { mode: "coexist" }) {
  const replacing = activation.mode === "replace";
  return {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-local-archive",
    type: "semantic-overlay",
    name: replacing ? "review" : "review-local-archive",
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
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      review: {
        revision: "fixture",
      },
    },
    activation,
  };
}

const DISCOVERY_GATE_TIMEOUT_MS = 5_000;

async function waitForDiscoveryGate(gate, label) {
  let timer;
  try {
    await Promise.race([
      gate,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} was not reached`));
        }, DISCOVERY_GATE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("binding state uses XDG then the agents fallback", () => {
  assert.equal(
    bindingStorePath({ env: { XDG_STATE_HOME: "/state" }, home: "/home/alice" }),
    "/state/skill-customization/bindings.json",
  );
  assert.equal(
    bindingStorePath({ env: {}, home: "/home/alice" }),
    "/home/alice/.agents/skill-customization/bindings.json",
  );
});

test("scope follows known target origin and custom paths require a choice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-"));
  const globalRoot = path.join(root, "global");
  const workspaceRoot = path.join(root, "workspace");
  const customRoot = path.join(root, "custom");
  await mkdir(path.join(globalRoot, "review"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "review"), { recursive: true });
  await mkdir(path.join(customRoot, "review"), { recursive: true });
  const roots = [
    { path: globalRoot, scope: "global", origin: "personal" },
    { path: workspaceRoot, scope: "workspace", origin: "project" },
  ];
  assert.equal(
    (await classifyBindingScope({ sourcePath: path.join(globalRoot, "review"), roots })).scope,
    "global",
  );
  assert.equal(
    (await classifyBindingScope({ sourcePath: path.join(workspaceRoot, "review"), roots })).scope,
    "workspace",
  );
  await assert.rejects(
    classifyBindingScope({ sourcePath: path.join(customRoot, "review"), roots }),
    (error) => error.code === "BINDING_SCOPE_REQUIRED",
  );
  assert.equal(
    (
      await classifyBindingScope({
        sourcePath: path.join(customRoot, "review"),
        roots,
        requestedScope: "global",
      })
    ).scope,
    "global",
  );
});

test("first use fails closed noninteractively and confirmed writes are atomic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];

  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: source,
      context: "global",
      statePath,
      roots,
      interactive: false,
    }),
    (error) => error.code === "FIRST_USE_CONFIRMATION_REQUIRED",
  );
  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
    now: () => "2026-08-04T00:00:00.000Z",
  });
  assert.equal(binding.scope, "global");
  assert.equal((await readBindingStore(statePath)).version, 1);
  assert.deepEqual(
    (await readdir(path.dirname(statePath))).filter((name) => name.endsWith(".tmp")),
    [],
  );
  const persisted = await readFile(statePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test("normal binding persistence rechecks the source fingerprint after confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-final-recheck-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\ninitial\n");
  const roots = [{ path: root, scope: "global", origin: "personal" }];

  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    interactive: true,
    confirm: async () => {
      await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\ncurrent\n");
      return true;
    },
  });

  assert.equal(binding.source.fingerprint, await fingerprintPath(source));
  assert.equal(
    (await readBindingStore(statePath)).bindings[bindingKey(descriptor().id, "global")]
      .source.fingerprint,
    binding.source.fingerprint,
  );
});

test("first-use publication rechecks full fingerprints in its atomic decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-full-fingerprint-race-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "state", "bindings.json");
  const helper = path.join(source, "helper.md");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  const release = await acquireStateLock(statePath);
  let signalNow;
  const nowReached = new Promise((resolve) => {
    signalNow = resolve;
  });
  const pending = bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
    now: async () => {
      await writeFile(helper, "changed after final inspection\n");
      signalNow();
      return "2026-08-04T00:00:00.000Z";
    },
  });
  const settled = pending.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  let gateError;
  try {
    await waitForDiscoveryGate(nowReached, "atomic fingerprint race gate");
  } catch (error) {
    gateError = error;
  } finally {
    await release();
  }
  const result = await settled;
  if (gateError) {
    throw gateError;
  }
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "BINDING_SOURCE_SELECTION_INVALID");
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("first-use publication accepts a SKILL.md file binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-file-source-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");

  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: path.join(source, "SKILL.md"),
    context: "global",
    statePath,
    roots: [{ path: root, scope: "global", origin: "personal" }],
    interactive: true,
    confirm: async () => true,
  });

  assert.equal(binding.source.path, path.resolve(path.join(source, "SKILL.md")));
  assert.equal(binding.source.target, await realpath(path.join(source, "SKILL.md")));
});

test("publication CAS binds nested repository provenance outside the skill directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-nested-git-provenance-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(root, ".git", "config"), "[remote \"origin\"]\nurl = initial\n");
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const release = await acquireStateLock(statePath);
  let signalNow;
  const nowReached = new Promise((resolve) => { signalNow = resolve; });
  const pending = bindCustomization({
    descriptor: descriptor(), sourcePath: source, context: "global", statePath,
    roots: [{ path: path.join(root, "skills"), scope: "global", origin: "personal" }],
    interactive: true, confirm: async () => true,
    now: async () => {
      await writeFile(path.join(root, ".git", "config"), "[remote \"origin\"]\nurl = changed\n");
      signalNow();
      return "2026-08-04T00:00:00.000Z";
    },
  });
  const settled = pending.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  let gateError;
  try { await waitForDiscoveryGate(nowReached, "nested provenance race gate"); } catch (error) { gateError = error; } finally { await release(); }
  const result = await settled;
  if (gateError) throw gateError;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "BINDING_SOURCE_SELECTION_INVALID");
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("publication CAS tracks git worktree config presence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-worktree-config-race-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(root, ".git", "config"), "[remote \"origin\"]\nurl = initial\n");
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const release = await acquireStateLock(statePath);
  let signalNow;
  const nowReached = new Promise((resolve) => { signalNow = resolve; });
  const pending = bindCustomization({
    descriptor: descriptor(), sourcePath: source, context: "global", statePath,
    roots: [{ path: path.join(root, "skills"), scope: "global", origin: "personal" }],
    interactive: true, confirm: async () => true,
    now: async () => {
      await writeFile(path.join(root, ".git", "config.worktree"), "[remote \"origin\"]\nurl = changed\n");
      signalNow();
      return "2026-08-04T00:00:00.000Z";
    },
  });
  const settled = pending.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  let gateError;
  try { await waitForDiscoveryGate(nowReached, "worktree config race gate"); } catch (error) { gateError = error; } finally { await release(); }
  const result = await settled;
  if (gateError) throw gateError;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "BINDING_SOURCE_SELECTION_INVALID");
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("plugin cache recovery preserves concurrent binding changes and deletions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-continuity-"));
  const versionOne = path.join(root, "plugin", "1", "skills", "review");
  const versionTwo = path.join(root, "plugin", "2", "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const plugin = {
    host: "fixture-host",
    marketplace: "fixture-marketplace",
    name: "reviewer",
    version: "1",
  };
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/reviewer";
  await mkdir(versionOne, { recursive: true });
  await writeFile(path.join(versionOne, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const effectiveFingerprint = await fingerprintPath(versionOne);
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      repository,
      upstream_path: "skills/review/SKILL.md",
      effective_fingerprint: effectiveFingerprint,
    },
  };
  const rootRecord = (directory, version) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin,
    pluginIdentity: identity,
    pluginRoots: [path.dirname(path.dirname(directory))],
    pluginEvidence: [{
      kind: "plugin",
      ...plugin,
      version,
      repository,
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  });
  await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: versionOne,
    context: "global",
    statePath,
    roots: [rootRecord(versionOne, "1")],
    interactive: true,
    confirm: async () => true,
  });
  await rename(path.join(root, "plugin", "1"), path.join(root, "removed"));
  await mkdir(versionTwo, { recursive: true });
  await writeFile(path.join(versionTwo, "SKILL.md"), "---\nname: review\n---\nstable\n");

  const resolved = await resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(versionTwo, "2")],
  });
  assert.equal(resolved.source.path, path.resolve(versionTwo));
  assert.equal(resolved.source.pluginIdentity, identity);
  assert.deepEqual(resolved.source.pluginCache, { kind: "versioned", scope: "global" });
  assert.equal(Object.hasOwn(resolved.source, "alias"), false);
  assert.equal(Object.hasOwn(resolved.source, "selection"), false);
  assert.equal((await readBindingStore(statePath)).bindings[`${encodeURIComponent(sourceDescriptor.id)}::global`].source.path, path.resolve(versionTwo));
  assert.equal(Object.hasOwn(sourceDescriptor, "plugin"), false);

  const versionThree = path.join(root, "plugin", "3", "skills", "review");
  const concurrentSource = path.join(root, "concurrent", "skills", "review");
  await rename(path.join(root, "plugin", "2"), path.join(root, "removed-two"));
  await mkdir(versionThree, { recursive: true });
  await mkdir(concurrentSource, { recursive: true });
  await writeFile(path.join(versionThree, "SKILL.md"), "---\nname: review\n---\nstable\n");
  await writeFile(path.join(concurrentSource, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const key = bindingKey(sourceDescriptor.id, "global");
  const store = await readBindingStore(statePath);
  const concurrentBinding = {
    ...structuredClone(store.bindings[key]),
    source: {
      ...structuredClone(store.bindings[key].source),
      path: path.resolve(concurrentSource),
      target: await realpath(concurrentSource),
    },
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  const release = await acquireStateLock(statePath);
  let signalTargetedDiscovery;
  let releaseTargetedDiscovery;
  const targetedDiscoveryReady = new Promise((resolve) => {
    signalTargetedDiscovery = resolve;
  });
  const targetedDiscoveryGate = new Promise((resolve) => {
    releaseTargetedDiscovery = resolve;
  });
  let discoveryPaused = false;
  const gatedDiscover = async (options) => {
    const result = await discoverFixtureSkills(options);
    if (!discoveryPaused && options.input !== undefined) {
      discoveryPaused = true;
      signalTargetedDiscovery();
      await targetedDiscoveryGate;
    }
    return result;
  };
  const pendingRecovery = resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(versionThree, "3")],
    discover: gatedDiscover,
  });
  let targetedGateError;
  try {
    await waitForDiscoveryGate(
      targetedDiscoveryReady,
      "targeted recovery discovery gate",
    );
    store.bindings[key] = concurrentBinding;
    await writeFile(statePath, `${JSON.stringify(store, null, 2)}\n`);
  } catch (error) {
    targetedGateError = error;
  } finally {
    await release();
    releaseTargetedDiscovery();
  }
  if (targetedGateError) {
    await pendingRecovery.catch(() => {});
    throw targetedGateError;
  }

  const afterRace = await pendingRecovery;
  assert.equal(afterRace.source.path, path.resolve(concurrentSource));
  assert.deepEqual((await readBindingStore(statePath)).bindings[key], concurrentBinding);

  const versionFour = path.join(root, "plugin", "4", "skills", "review");
  await rename(path.join(root, "concurrent"), path.join(root, "removed-concurrent"));
  await mkdir(versionFour, { recursive: true });
  await writeFile(path.join(versionFour, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const releaseDeletion = await acquireStateLock(statePath);
  let signalDeletionDiscovery;
  let releaseDeletionDiscovery;
  const deletionDiscoveryReady = new Promise((resolve) => {
    signalDeletionDiscovery = resolve;
  });
  const deletionDiscoveryGate = new Promise((resolve) => {
    releaseDeletionDiscovery = resolve;
  });
  let deletionDiscoveryPaused = false;
  const gatedDeletionDiscover = async (options) => {
    const result = await discoverFixtureSkills(options);
    if (!deletionDiscoveryPaused && options.input !== undefined) {
      deletionDiscoveryPaused = true;
      signalDeletionDiscovery();
      await deletionDiscoveryGate;
    }
    return result;
  };
  const pendingDeletion = resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(versionFour, "4")],
    discover: gatedDeletionDiscover,
  });
  let deletionGateError;
  try {
    await waitForDiscoveryGate(
      deletionDiscoveryReady,
      "deletion recovery discovery gate",
    );
    const deletedStore = await readBindingStore(statePath);
    delete deletedStore.bindings[key];
    await writeFile(statePath, `${JSON.stringify(deletedStore, null, 2)}\n`);
  } catch (error) {
    deletionGateError = error;
  } finally {
    await releaseDeletion();
    releaseDeletionDiscovery();
  }
  if (deletionGateError) {
    await pendingDeletion.catch(() => {});
    throw deletionGateError;
  }

  await assert.rejects(
    pendingDeletion,
    (error) => error.code === "BINDING_NOT_FOUND",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("plugin cache recovery rejects mismatched upstream paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-cache-missing-"));
  const install = path.join(root, "plugin", "1");
  const source = path.join(install, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/skills";
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      effective_fingerprint: await fingerprintPath(source),
    },
  };
  const rootRecord = {
    path: path.dirname(source),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin: {
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      name: "reviewer",
      version: "1",
    },
    pluginIdentity: identity,
    pluginRoot: install,
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      plugin: "reviewer",
      repository,
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  };
  await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: source,
    context: "global",
    statePath,
    roots: [rootRecord],
    interactive: true,
    confirm: async () => true,
  });
  await rename(install, path.join(root, "removed"));
  const replacementInstall = path.join(root, "plugin", "2");
  const replacement = path.join(replacementInstall, "skills", "review");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const replacementRoot = {
    ...rootRecord,
    path: path.dirname(replacement),
    pluginRoot: replacementInstall,
  };

  await assert.rejects(
    resolveBinding({
      descriptor: sourceDescriptor,
      context: "global",
      statePath,
      roots: [replacementRoot],
      managerRecords: [{
        manager: "asm",
        name: "review",
        path: replacement,
        source: {
          kind: "repository",
          repository,
          upstreamPath: "other/review/SKILL.md",
        },
      }],
    }),
    (error) => error.code === "BINDING_TARGET_MISSING",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("plugin cache recovery targets outside a seeded same-name inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-cache-targeted-"));
  const installOne = path.join(root, "plugin", "1");
  const sourceOne = path.join(installOne, "skills", "review");
  const installTwo = path.join(root, "plugin", "2");
  const sourceTwo = path.join(installTwo, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/skills";
  const workflow = "---\nname: review\n---\nstable\n";
  const rootRecord = (directory, version) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin: {
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      name: "reviewer",
      version,
    },
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      plugin: "reviewer",
      repository,
      identity,
      version,
      cache: { kind: "versioned", scope: "global" },
    }],
  });

  await mkdir(sourceOne, { recursive: true });
  await writeFile(path.join(sourceOne, "SKILL.md"), workflow);
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      effective_fingerprint: await fingerprintPath(sourceOne),
    },
  };
  const initialRoot = rootRecord(sourceOne, "1");
  const replacementRoot = rootRecord(sourceTwo, "2");
  await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: sourceOne,
    context: "global",
    statePath,
    roots: [initialRoot],
    interactive: true,
    confirm: async () => true,
  });
  const seeded = await discoverFixtureSkills({
    roots: [initialRoot],
    managerRecords: [],
  });

  await rename(installOne, path.join(root, "removed"));
  await mkdir(sourceTwo, { recursive: true });
  await writeFile(path.join(sourceTwo, "SKILL.md"), workflow);
  const recovered = await resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    discovery: seeded,
    roots: [initialRoot, replacementRoot],
    managerRecords: [],
  });

  assert.equal(recovered.source.path, path.resolve(sourceTwo));
  assert.equal(recovered.source.pluginIdentity, identity);
});

test("plugin cache recovery returns a bounded failure when fresh validation rejects a candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-cache-bounded-recovery-"));
  const installOne = path.join(root, "plugin", "1");
  const sourceOne = path.join(installOne, "skills", "review");
  const installTwo = path.join(root, "plugin", "2");
  const sourceTwo = path.join(installTwo, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/skills";
  const plugin = {
    host: "fixture-host",
    marketplace: "fixture-marketplace",
    name: "reviewer",
  };
  const rootRecord = (directory, version) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin: { ...plugin, version },
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      ...plugin,
      version,
      repository,
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  });
  const stableWorkflow = "---\nname: review\n---\nstable\n";
  const changedWorkflow = "---\nname: review\n---\nchanged\n";

  await mkdir(sourceOne, { recursive: true });
  await writeFile(path.join(sourceOne, "SKILL.md"), stableWorkflow);
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      repository,
      effective_fingerprint: await fingerprintPath(sourceOne),
    },
  };
  await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: sourceOne,
    context: "global",
    statePath,
    roots: [rootRecord(sourceOne, "1")],
    interactive: true,
    confirm: async () => true,
  });
  await rename(installOne, path.join(root, "removed"));
  await mkdir(sourceTwo, { recursive: true });
  await writeFile(path.join(sourceTwo, "SKILL.md"), stableWorkflow);

  let targetedCalls = 0;
  let signalSecondTarget;
  let releaseSecondTarget;
  const secondTargetReady = new Promise((resolve) => {
    signalSecondTarget = resolve;
  });
  const secondTargetGate = new Promise((resolve) => {
    releaseSecondTarget = resolve;
  });
  const gatedDiscover = async (options) => {
    const result = await discoverFixtureSkills(options);
    if (options.input !== undefined) {
      targetedCalls += 1;
      if (targetedCalls === 2) {
        await writeFile(path.join(sourceTwo, "SKILL.md"), changedWorkflow);
        signalSecondTarget();
        await secondTargetGate;
      }
    }
    return result;
  };

  const pending = resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(sourceTwo, "2")],
    discover: gatedDiscover,
  });
  let secondTargetGateError;
  try {
    await waitForDiscoveryGate(secondTargetReady, "second targeted recovery gate");
  } catch (error) {
    secondTargetGateError = error;
  } finally {
    releaseSecondTarget();
  }
  if (secondTargetGateError) {
    await pending.catch(() => {});
    throw secondTargetGateError;
  }

  await assert.rejects(
    pending,
    (error) => error.code === "BINDING_TARGET_MISSING",
  );
  assert.equal(targetedCalls, 2);
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("plugin cache recovery keeps seeded and targeted eligible copies ambiguous", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-cache-ambiguous-targeted-"));
  const installOne = path.join(root, "plugin", "1");
  const sourceOne = path.join(installOne, "skills", "review");
  const seededInstall = path.join(root, "plugin", "seed");
  const seededSource = path.join(seededInstall, "skills", "review");
  const installTwo = path.join(root, "plugin", "2");
  const sourceTwo = path.join(installTwo, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/skills";
  const workflow = "---\nname: review\n---\nstable\n";
  const rootRecord = (directory, version) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin: {
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      name: "reviewer",
      version,
    },
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      plugin: "reviewer",
      repository,
      identity,
      version,
      cache: { kind: "versioned", scope: "global" },
    }],
  });

  await mkdir(sourceOne, { recursive: true });
  await mkdir(seededSource, { recursive: true });
  await writeFile(path.join(sourceOne, "SKILL.md"), workflow);
  await writeFile(path.join(seededSource, "SKILL.md"), workflow);
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      effective_fingerprint: await fingerprintPath(sourceOne),
    },
  };
  const initialRoots = [
    rootRecord(sourceOne, "1"),
    rootRecord(seededSource, "seed"),
  ];
  const replacementRoot = rootRecord(sourceTwo, "2");
  await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: sourceOne,
    context: "global",
    statePath,
    roots: initialRoots,
    interactive: true,
    confirm: async () => true,
  });
  const seeded = await discoverFixtureSkills({
    roots: initialRoots,
    managerRecords: [],
  });

  await rename(installOne, path.join(root, "removed"));
  await mkdir(sourceTwo, { recursive: true });
  await writeFile(path.join(sourceTwo, "SKILL.md"), workflow);
  await assert.rejects(
    resolveBinding({
      descriptor: sourceDescriptor,
      context: "global",
      statePath,
      discovery: seeded,
      roots: [...initialRoots, replacementRoot],
      managerRecords: [],
    }),
    (error) => error.code === "BINDING_TARGET_MISSING",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("automatic plugin recovery requires a same-scope versioned cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-cache-policy-"));
  const directSource = path.join(root, "workspace-direct", "skills", "review");
  const directReplacement = path.join(root, "global-direct", "skills", "review");
  const cacheSource = path.join(root, "workspace-cache", "skills", "review");
  const cacheReplacement = path.join(root, "global-cache", "skills", "review");
  const workflow = "---\nname: review\n---\nstable\n";
  const plugin = {
    host: "fixture-host",
    marketplace: "fixture-marketplace",
    name: "reviewer",
  };
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/reviewer";
  const rootRecord = (directory, scope, versioned = false) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope,
    origin: "plugin",
    plugin,
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      ...plugin,
      repository,
      identity,
      ...(versioned ? { cache: { kind: "versioned", scope } } : {}),
    }],
  });

  await mkdir(directSource, { recursive: true });
  await writeFile(path.join(directSource, "SKILL.md"), workflow);
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      repository,
      effective_fingerprint: await fingerprintPath(directSource),
    },
  };
  const assertMissingRecovery = async ({
    sourcePath,
    replacementPath,
    statePath,
    context,
    initialRoots,
    replacementRoots,
    assertBinding = async () => {},
  }) => {
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "SKILL.md"), workflow);
    const binding = await bindCustomization({
      descriptor: sourceDescriptor,
      sourcePath,
      context,
      statePath,
      roots: initialRoots,
      interactive: true,
      confirm: async () => true,
    });
    await assertBinding(binding);
    await rename(sourcePath, path.join(root, `removed-${context}`));
    await mkdir(replacementPath, { recursive: true });
    await writeFile(path.join(replacementPath, "SKILL.md"), workflow);
    await assert.rejects(
      resolveBinding({
        descriptor: sourceDescriptor,
        context,
        statePath,
        roots: replacementRoots,
      }),
      (error) => error.code === "BINDING_TARGET_MISSING",
    );
    assert.deepEqual((await readBindingStore(statePath)).bindings, {});
  };

  await assertMissingRecovery({
    sourcePath: directSource,
    replacementPath: directReplacement,
    statePath: path.join(root, "direct-state", "bindings.json"),
    context: "workspace-direct",
    initialRoots: [rootRecord(directSource, "workspace")],
    replacementRoots: [rootRecord(directReplacement, "global")],
    assertBinding: async (binding) => {
      assert.equal(binding.source.pluginIdentity, identity);
      assert.equal(Object.hasOwn(binding.source, "pluginCache"), false);
    },
  });

  await assertMissingRecovery({
    sourcePath: cacheSource,
    replacementPath: cacheReplacement,
    statePath: path.join(root, "cache-state", "bindings.json"),
    context: "workspace-cache",
    initialRoots: [
      {
        path: cacheSource,
        owner: "workspace",
        scope: "workspace",
        origin: "project",
      },
      rootRecord(cacheSource, "workspace", true),
    ],
    replacementRoots: [rootRecord(cacheReplacement, "global", true)],
    assertBinding: async (binding) => {
      assert.equal(binding.source.pluginIdentity, identity);
      assert.deepEqual(binding.source.pluginCache, {
        kind: "versioned",
        scope: "workspace",
      });
    },
  });

  const auditSource = path.join(root, "workspace-audit", "skills", "review");
  const auditReplacement = path.join(root, "workspace-audit-replacement", "skills", "review");
  await assertMissingRecovery({
    sourcePath: auditSource,
    replacementPath: auditReplacement,
    statePath: path.join(root, "audit-state", "bindings.json"),
    context: "workspace-audit",
    initialRoots: [rootRecord(auditSource, "workspace", true)],
    replacementRoots: [{
      ...rootRecord(auditReplacement, "workspace", true),
      active: false,
    }],
  });
});

test("versioned cache recovery checks a customization execution graph", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-customization-cache-"));
  const versionOne = path.join(root, "plugin", "1", "skills", "review-fork");
  const versionTwo = path.join(root, "plugin", "2", "skills", "review-fork");
  const statePath = path.join(root, "state", "bindings.json");
  const context = "global";
  const plugin = {
    host: "fixture-host",
    marketplace: "fixture-marketplace",
    name: "review-fork-plugin",
  };
  const identity = "local:plugin:fixture-host:fixture-marketplace:review-fork-plugin";
  const writeFork = async (directory) => {
    const snapshot = path.join(directory, "provenance", "source");
    const skillHeader = "---\nname: review-fork\n---\n";
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, "SKILL.md"), `${skillHeader}snapshot\n`);
    await writeFile(path.join(directory, "SKILL.md"), `${skillHeader}fork\n`);
    await writeFile(path.join(directory, "CUSTOMIZATION.md"), "Fork rationale.\n");
    const diffPath = path.join(directory, "provenance", "source.diff");
    await writeFile(
      diffPath,
      "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,4 +1,4 @@\n ---\n name: review-fork\n ---\n-snapshot\n+fork\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+Fork rationale.\n",
    );
    const snapshotFingerprint = await fingerprintPath(snapshot);
    const nestedDescriptor = {
      schema_version: 1,
      id: "urn:skill-customization:fixture:review-fork-cache",
      type: "fork",
      name: "review-fork",
      license: "MIT",
      entrypoint: "SKILL.md",
      customization: "CUSTOMIZATION.md",
      dependencies: [],
      owned_payload: { reviewed_fingerprint: await payloadFingerprint(directory) },
      source: {
        skill_name: "review",
        kind: "repository",
        repository: "https://github.com/example/skills",
        upstream_path: "skills/review/SKILL.md",
        license: "MIT",
        effective_fingerprint: snapshotFingerprint,
        review: { revision: "fixture" },
      },
      activation: { mode: "coexist" },
      fork: {
        snapshot: "provenance/source",
        diff: "provenance/source.diff",
        snapshot_fingerprint: snapshotFingerprint,
        diff_fingerprint: await fingerprintFile(diffPath),
      },
    };
    await writeFile(
      path.join(directory, "customization.json"),
      `${JSON.stringify(nestedDescriptor, null, 2)}\n`,
    );
    return nestedDescriptor;
  };
  const rootRecord = (directory, version) => ({
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin: { ...plugin, version },
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      ...plugin,
      version,
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  });

  const nestedDescriptor = await writeFork(versionOne);
  const nestedExecution = await preflightCustomization({
    descriptorPath: path.join(versionOne, "customization.json"),
    context,
    statePath,
  });
  assert.equal(nestedExecution.status, "ready");
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      skill_name: nestedDescriptor.name,
      kind: "customization",
      id: nestedDescriptor.id,
      type: nestedDescriptor.type,
      license: nestedDescriptor.license,
      effective_fingerprint: nestedExecution.effectiveFingerprint,
    },
  };
  const bound = await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: versionOne,
    context,
    statePath,
    roots: [rootRecord(versionOne, "1")],
    interactive: true,
    confirm: async () => true,
  });
  assert.deepEqual(bound.source.customization, {
    id: nestedDescriptor.id,
    type: nestedDescriptor.type,
    license: nestedDescriptor.license,
  });
  assert.deepEqual(bound.source.pluginCache, { kind: "versioned", scope: "global" });

  await rename(path.join(root, "plugin", "1"), path.join(root, "removed"));
  await writeFork(versionTwo);
  await assert.rejects(
    resolveBinding({
      descriptor: sourceDescriptor,
      context,
      statePath,
      roots: [rootRecord(versionTwo, "2")],
    }),
    (error) => error.code === "BINDING_CUSTOMIZATION_RECOVERY_UNAVAILABLE",
  );
  const runtime = createBindingRuntime({
    context: {
      roots: [rootRecord(versionTwo, "2")],
      managerRecords: [],
    },
    inspectExecution: inspectCustomizationExecution,
  });
  const recovered = await runtime.resolveBinding({
    descriptor: sourceDescriptor,
    context,
    statePath,
  });
  assert.equal(recovered.source.path, path.resolve(versionTwo));
  assert.equal(recovered.source.pluginIdentity, identity);
  assert.deepEqual(recovered.source.customization, bound.source.customization);

  // Hold the outer publication on its fifth recursive inspection: the first
  // four are candidate generation/revalidation outside the lock, while the
  // fifth is the lock-side read-only graph CAS. A nested owned file changing
  // at that point must prevent the stale effective fingerprint from landing.
  const versionThree = path.join(root, "plugin", "3", "skills", "review-fork");
  await rename(path.join(root, "plugin", "2"), path.join(root, "removed-two"));
  await writeFork(versionThree);
  let executionChecks = 0;
  const racingRuntime = createBindingRuntime({
    context: {
      roots: [rootRecord(versionThree, "3")],
      managerRecords: [],
    },
    inspectExecution: async (intent) => {
      executionChecks += 1;
      if (executionChecks === 5) {
        await writeFile(path.join(versionThree, "CUSTOMIZATION.md"), "changed in lock\n");
      }
      return inspectCustomizationExecution(intent);
    },
  });
  await assert.rejects(
    racingRuntime.resolveBinding({
      descriptor: sourceDescriptor,
      context,
      statePath,
    }),
    (error) => error.code === "BINDING_SOURCE_SELECTION_INVALID",
  );
  assert.equal(executionChecks, 5);
});

test("concurrent bindings preserve distinct context keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-concurrent-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];
  let confirmations = 0;
  let release;
  const bothReady = new Promise((resolve) => {
    release = resolve;
  });
  const confirm = async () => {
    confirmations += 1;
    if (confirmations === 2) release();
    await bothReady;
    return true;
  };

  await Promise.all(
    ["workspace-one", "workspace-two"].map((context) =>
      bindCustomization({
        descriptor: descriptor(),
        sourcePath: source,
        context,
        statePath,
        roots,
        interactive: true,
        confirm,
      }),
    ),
  );

  const store = await readBindingStore(statePath);
  assert.equal(Object.keys(store.bindings).length, 2);
});

test("symlink bindings record alias and target, then invalidate on retarget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "retarget-"));
  const workspaceRoot = path.join(root, "workspace");
  const targetOne = path.join(workspaceRoot, "one");
  const targetTwo = path.join(workspaceRoot, "two");
  const aliasRoot = path.join(root, "aliases");
  const alias = path.join(aliasRoot, "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(targetOne, { recursive: true });
  await mkdir(targetTwo, { recursive: true });
  await mkdir(aliasRoot, { recursive: true });
  await writeFile(path.join(targetOne, "SKILL.md"), "---\nname: review\n---\none\n");
  await writeFile(path.join(targetTwo, "SKILL.md"), "---\nname: review\n---\ntwo\n");
  await symlink(targetOne, alias);
  const roots = [
    { path: workspaceRoot, scope: "workspace", origin: "project" },
    { path: aliasRoot, scope: "global", origin: "personal" },
  ];
  const managerRecords = [];
  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: alias,
    context: "/workspace",
    statePath,
    roots,
    managerRecords,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.scope, "workspace");
  assert.equal(binding.source.alias, alias);
  const canonicalTargetOne = await realpath(targetOne);
  assert.equal(binding.source.target, canonicalTargetOne);
  assert.equal(
    (
      await resolveBinding({
        descriptor: descriptor(),
        context: "/workspace",
        statePath,
        roots,
        managerRecords,
      })
    ).source.target,
    canonicalTargetOne,
  );

  await unlink(alias);
  await symlink(targetTwo, alias);
  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "/workspace",
      statePath,
      roots,
      managerRecords,
    }),
    (error) => error.code === "BINDING_RETARGETED",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 0);
});

test("replacement binding requires a separate explicit confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-"));
  const source = path.join(root, "review");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  const managerRecords = [];
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "bindings.json"),
      roots,
      managerRecords,
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => false,
    }),
    (error) => error.code === "REPLACEMENT_CONFIRMATION_REQUIRED",
  );
  const otherSource = path.join(root, "other-review");
  await mkdir(otherSource);
  await writeFile(path.join(otherSource, "SKILL.md"), "---\nname: review\n---\nother\n");
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "ambiguous-bindings.json"),
      roots,
      managerRecords,
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => true,
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT",
  );
});

test("replacement validation merges a seeded inventory with targeted discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-targeted-discovery-"));
  const source = path.join(root, "review");
  const otherSource = path.join(root, "other-review");
  const statePath = path.join(root, "bindings.json");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const seeded = await discoverFixtureSkills({ roots, managerRecords: [] });
  await mkdir(otherSource);
  await writeFile(path.join(otherSource, "SKILL.md"), "---\nname: review\n---\nother\n");

  await assert.rejects(
    bindCustomization({
      descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
      sourcePath: source,
      context: "global",
      statePath,
      roots,
      discovery: seeded,
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => true,
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT"
      && Array.isArray(error.details)
      && error.details.length === 2,
  );
});

test("persisted replacement validation owns the current active inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-validation-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "bindings.json");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  const managerRecords = [];
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const replacement = descriptor({
    mode: "replace",
    precedence: "customization-first",
  });
  const binding = await bindCustomization({
    descriptor: replacement,
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords,
    interactive: true,
    confirm: async () => true,
    confirmReplace: async () => true,
  });

  const persistedRecord =
    (await readBindingStore(statePath)).bindings[bindingKey(replacement.id, "global")];
  const persistedCandidate = persistedRecord.evidenceRevision.replacement.candidates[0];
  const persistedReplacement = persistedRecord.evidenceRevision.replacement;
  assert.equal(persistedCandidate.fingerprint, await fingerprintPath(source));
  assert.equal(typeof persistedCandidate.metadataRevision, "string");
  assert.equal(typeof persistedReplacement.contextRevision, "string");
  assert.equal(typeof persistedReplacement.discoveryRevision, "string");
  assert.ok(Array.isArray(persistedCandidate.provenance));
  assert.ok(Array.isArray(persistedCandidate.evidence));
  assert.equal(persistedCandidate.group.fingerprint, persistedCandidate.fingerprint);
  assert.equal(persistedCandidate.copy.path, path.resolve(source));
  assert.equal(persistedCandidate.identities.length, 1);
  assert.equal(persistedCandidate.identities[0].group.name, "review");
  assert.equal(
    persistedCandidate.identities[0].group.fingerprint,
    persistedCandidate.fingerprint,
  );
  assert.equal(persistedCandidate.identities[0].copy.path, path.resolve(source));

  assert.equal(
    (await validateBinding({ descriptor: replacement, binding, roots, managerRecords })).binding,
    binding,
  );
  const otherSource = path.join(root, "other-review");
  await mkdir(otherSource);
  await writeFile(path.join(otherSource, "SKILL.md"), "---\nname: review\n---\nother\n");
  await assert.rejects(
    validateBinding({
      descriptor: replacement,
      binding,
      roots,
      managerRecords,
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT",
  );
});

test("replacement binding rechecks active inventory before atomic persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-final-inventory-"));
  const source = path.join(root, "review");
  const otherSource = path.join(root, "other-review");
  const statePath = path.join(root, "bindings.json");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  const replacement = descriptor({
    mode: "replace",
    precedence: "customization-first",
  });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");

  await assert.rejects(
    bindCustomization({
      descriptor: replacement,
      sourcePath: source,
      context: "global",
      statePath,
      roots,
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => {
        await mkdir(otherSource, { recursive: true });
        await writeFile(
          path.join(otherSource, "SKILL.md"),
          "---\nname: review\n---\nother\n",
        );
        return true;
      },
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("replacement publication rejects changed customization metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-customization-race-"));
  const source = path.join(root, "source");
  const replacement = path.join(root, "review");
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(replacement, "SKILL.md"), "---\nname: review\n---\nreplacement\n");
  await writeFile(path.join(replacement, "CUSTOMIZATION.md"), "Replacement.\n");
  const replacementMetadata = {
    ...descriptor({ mode: "replace", precedence: "customization-first" }),
    id: "urn:skill-customization:fixture:replacement-metadata",
    owned_payload: { reviewed_fingerprint: "placeholder" },
  };
  await writeFile(
    path.join(replacement, "customization.json"),
    `${JSON.stringify(replacementMetadata, null, 2)}\n`,
  );
  replacementMetadata.owned_payload.reviewed_fingerprint =
    await payloadFingerprint(replacement);
  await writeFile(
    path.join(replacement, "customization.json"),
    `${JSON.stringify(replacementMetadata, null, 2)}\n`,
  );

  const release = await acquireStateLock(statePath);
  let signalNow;
  const nowReached = new Promise((resolve) => {
    signalNow = resolve;
  });
  const pending = bindCustomization({
    descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
    sourcePath: source,
    customizationRoot: source,
    context: "global",
    statePath,
    roots,
    managerRecords: [],
    discover: discoverFixtureSkills,
    interactive: true,
    confirm: async () => true,
    confirmReplace: async () => true,
    now: async () => {
      const metadataPath = path.join(replacement, "customization.json");
      const current = JSON.parse(await readFile(metadataPath, "utf8"));
      current.source.review.revision = "changed-after-evidence";
      await writeFile(
        metadataPath,
        `${JSON.stringify(current, null, 2)}\n`,
      );
      signalNow();
      return "2026-08-04T00:00:00.000Z";
    },
  });
  const settled = pending.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  let gateError;
  try {
    await waitForDiscoveryGate(nowReached, "replacement metadata race gate");
  } catch (error) {
    gateError = error;
  } finally {
    await release();
  }
  const result = await settled;
  if (gateError) throw gateError;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "BINDING_SOURCE_SELECTION_INVALID");
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("binding rejects the wrong declared source name and conflicting repository evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-source-"));
  const source = path.join(root, "skills", "other");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: other\n---\nwrong\n");
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "state.json"),
      roots: [{ path: path.dirname(source), scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_SOURCE_NAME_MISMATCH",
  );
});

test("binding rejects a different local identity and non-SKILL file inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-local-"));
  const source = path.join(root, "review");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nlocal\n");
  const localDescriptor = {
    ...descriptor(),
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      effective_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      identity:
        "local:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
  await assert.rejects(
    bindCustomization({
      descriptor: localDescriptor,
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "local-state.json"),
      roots: [{ path: root, scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_LOCAL_IDENTITY_MISMATCH",
  );
  const otherFile = path.join(root, "review.md");
  await writeFile(otherFile, "---\nname: review\n---\nfile\n");
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: otherFile,
      context: "global",
      statePath: path.join(root, "file-state.json"),
      roots: [{ path: root, scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_SOURCE_INVALID",
  );
});

test("binding rejects conflicting repository provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-repository-"));
  const source = path.join(root, "review");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  assert.equal(spawnSync("git", ["init", "-q", source]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", source, "remote", "add", "origin", "https://github.com/other/skills"]).status,
    0,
  );
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "state.json"),
      roots: [{ path: root, scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_SOURCE_PROVENANCE_MISMATCH",
  );
});

test("binding persists and revalidates an auditable provenance choice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-confirmed-provenance-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const managerRecords = [
    {
      manager: "asm",
      name: "review",
      path: source,
      source: {
        kind: "repository",
        repository: "https://github.com/example/skills",
        upstreamPath: "skills/review/SKILL.md",
      },
    },
    {
      manager: "xing",
      name: "review",
      path: source,
      source: {
        kind: "repository",
        repository: "https://github.com/other/skills",
        upstreamPath: "skills/review/SKILL.md",
      },
    },
  ];
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];
  const discovery = await discoverFixtureSkills({ input: source, roots, managerRecords });
  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords,
    discovery,
    selectSource: async ({ discovery: sourceDiscovery, group: sourceGroup }) => {
      const copy = sourceGroup.copies.find(({ owner }) => owner === "manager:asm");
      return confirmDiscoverySelection({
        discovery: sourceDiscovery,
        choice: {
          name: sourceGroup.name,
          fingerprint: sourceGroup.fingerprint,
          path: copy.path,
          owner: copy.owner,
        },
        interactive: true,
        confirmedProvenance:
          "repository:https://github.com/example/skills#skills/review/SKILL.md",
        confirmationEvidence: {
          actor: "human",
          reason: "selected the ASM-owned repository source",
        },
      });
    },
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.source.confirmation, "provenance-confirmed");
  assert.equal(binding.source.selection.fingerprint, undefined);
  assert.equal(
    binding.source.selection.provenance,
    "repository:https://github.com/example/skills#skills/review/SKILL.md",
  );
  assert.equal(
    (
      await resolveBinding({
        descriptor: descriptor(),
        context: "global",
        statePath,
        roots,
        managerRecords,
      })
    ).source.selection.provenance,
    binding.source.selection.provenance,
  );

  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: review\n---\nupstream content drift\n",
  );
  const afterDrift = await resolveBinding({
    descriptor: descriptor(),
    context: "global",
    statePath,
    roots,
    managerRecords,
  });
  assert.equal(afterDrift.source.selection.provenance, binding.source.selection.provenance);

  const tamperedStore = await readBindingStore(statePath);
  tamperedStore.bindings[bindingKey(descriptor().id, "global")]
    .source.selection.confirmation.provenance =
    "repository:https://github.com/other/skills#skills/review/SKILL.md";
  await writeFile(statePath, `${JSON.stringify(tamperedStore)}\n`);
  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "global",
      statePath,
      roots,
      managerRecords,
    }),
    (error) => error.code === "BINDING_SOURCE_PROVENANCE_MISMATCH",
  );
});

test("persisted binding does not trust stale seeded source provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-stale-seed-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];
  const originalRecords = [{
    manager: "asm",
    name: "review",
    path: source,
    source: {
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review/SKILL.md",
    },
  }];
  const currentRecords = [{
    ...originalRecords[0],
    source: {
      ...originalRecords[0].source,
      repository: "https://github.com/other/skills",
    },
  }];
  const seeded = await discoverFixtureSkills({
    input: source,
    roots,
    managerRecords: originalRecords,
  });

  await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords: originalRecords,
    discovery: seeded,
    interactive: true,
    confirm: async () => true,
  });

  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "global",
      statePath,
      roots,
      managerRecords: currentRecords,
      discovery: seeded,
    }),
    (error) => error.code === "BINDING_SOURCE_PROVENANCE_MISMATCH",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("first use revalidates seeded source provenance without a selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-first-use-stale-seed-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];
  const originalRecords = [{
    manager: "asm",
    name: "review",
    path: source,
    source: {
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review/SKILL.md",
    },
  }];
  const currentRecords = [{
    ...originalRecords[0],
    source: {
      ...originalRecords[0].source,
      repository: "https://github.com/other/skills",
    },
  }];
  const seeded = await discoverFixtureSkills({
    input: source,
    roots,
    managerRecords: originalRecords,
  });

  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: source,
      context: "global",
      statePath,
      roots,
      managerRecords: currentRecords,
      discovery: seeded,
      discover: discoverFixtureSkills,
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_SOURCE_PROVENANCE_MISMATCH",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("binding accepts an unambiguous checked selection with path-only confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-path-only-confirmation-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(
    spawnSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/example/skills",
    ]).status,
    0,
  );
  const roots = [{ path: path.dirname(source), scope: "global", origin: "personal" }];
  const discovery = await discoverFixtureSkills({ input: source, roots, managerRecords: [] });
  const group = discovery.groups[0];
  const copy = group.copies[0];
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: copy.path,
      owner: copy.owner,
    },
    interactive: true,
  });

  assert.equal(confirmedSelection.provenance, `repository:https://github.com/example/skills#skills/review/SKILL.md`);
  assert.equal(confirmedSelection.evidence.at(-1).provenance, undefined);
  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords: [],
    confirmedSelection,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.source.selection.provenance, confirmedSelection.provenance);
  assert.equal(binding.source.selection.confirmation.provenance, undefined);
});

test("binding accepts confirmed repository-only plugin provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-plugin-repository-only-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  const repository = "https://github.com/example/skills";
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(
    spawnSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/other/skills",
    ]).status,
    0,
  );
  const pluginIdentity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const roots = [{
    path: path.dirname(source),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    pluginRoot: root,
    pluginIdentity,
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: "fixture-marketplace",
      plugin: "reviewer",
      identity: pluginIdentity,
      repository,
    }],
  }];
  const discovery = await discoverFixtureSkills({ input: source, roots, managerRecords: [] });
  const group = discovery.groups[0];
  const chosenCopy = group.copies.find(({ owner }) => owner === "plugin:fixture-host");
  const repositoryOnlyProvenance = `repository:${repository}`;
  assert.equal(group.conflict, true);
  assert.ok(chosenCopy.provenance.includes(repositoryOnlyProvenance));
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: chosenCopy.path,
      owner: chosenCopy.owner,
    },
    interactive: true,
    confirmedProvenance: repositoryOnlyProvenance,
    confirmationEvidence: {
      actor: "human",
      reason: "selected repository-only plugin evidence over conflicting Git evidence",
    },
  });

  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords: [],
    confirmedSelection,
    interactive: true,
    confirm: async () => true,
  });

  assert.equal(binding.source.repository, repository);
  assert.equal(binding.source.upstreamPath, "skills/review/SKILL.md");
  assert.equal(binding.source.selection.provenance, repositoryOnlyProvenance);

  assert.equal(
    spawnSync("git", ["-C", root, "remote", "set-url", "origin", repository])
      .status,
    0,
  );
  const updatedDiscovery = await discoverFixtureSkills({
    input: source,
    roots,
    managerRecords: [],
  });
  assert.deepEqual(updatedDiscovery.groups[0].provenance, [
    repositoryOnlyProvenance,
    `${repositoryOnlyProvenance}#skills/review/SKILL.md`,
  ]);
  const resolved = await resolveBinding({
    descriptor: descriptor(),
    context: "global",
    statePath,
    roots,
    managerRecords: [],
  });
  assert.equal(resolved.source.selection.provenance, repositoryOnlyProvenance);

  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "global",
      statePath,
      roots,
      managerRecords: [{
        manager: "asm",
        name: "review",
        path: source,
        source: {
          kind: "repository",
          repository,
          upstreamPath: "other/review/SKILL.md",
        },
      }],
    }),
    (error) => error.code === "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
  );
});

test("binding persists the confirmed plugin identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-confirmed-plugin-identity-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  const entrypoint = path.join(source, "SKILL.md");
  await mkdir(source, { recursive: true });
  await writeFile(entrypoint, "---\nname: review\n---\nsource\n");
  const identities = [
    "local:plugin:fixture-host:first:reviewer",
    "local:plugin:fixture-host:confirmed:reviewer",
  ];
  const roots = identities.map((identity, index) => ({
    path: path.dirname(source),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    pluginRoot: root,
    pluginIdentity: identity,
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: index === 0 ? "first" : "confirmed",
      plugin: "reviewer",
      identity,
    }],
  }));
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      effective_fingerprint: await fingerprintPath(source),
      identity: generateLocalIdentity({
        skillName: "review",
        fingerprint: await fingerprintFile(entrypoint),
      }),
    },
  };
  const discovery = await discoverFixtureSkills({ input: source, roots, managerRecords: [] });
  const group = discovery.groups[0];
  const chosenCopy = group.copies.find(({ owner }) => owner === "plugin:fixture-host");
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: chosenCopy.path,
      owner: chosenCopy.owner,
    },
    interactive: true,
    confirmedProvenance: identities[1],
    confirmationEvidence: {
      actor: "human",
      reason: "selected the confirmed marketplace identity",
    },
  });

  const binding = await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    confirmedSelection,
    interactive: true,
    confirm: async () => true,
  });

  assert.equal(binding.source.selection.provenance, identities[1]);
  assert.equal(binding.source.pluginIdentity, identities[1]);
});

test("confirmed aggregated plugin evidence retains versioned-cache recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-confirmed-plugin-cache-"));
  const versionOneRoot = path.join(root, "plugin", "1");
  const versionTwoRoot = path.join(root, "plugin", "2");
  const versionOne = path.join(versionOneRoot, "skills", "review");
  const versionTwo = path.join(versionTwoRoot, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const workflow = "---\nname: review\n---\nstable\n";
  await mkdir(versionOne, { recursive: true });
  await writeFile(path.join(versionOne, "SKILL.md"), workflow);
  const identities = [
    "local:plugin:fixture-host:first:reviewer",
    "local:plugin:fixture-host:confirmed:reviewer",
  ];
  const rootsFor = (source, pluginRoot) => identities.map((identity, index) => ({
    path: path.dirname(source),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    pluginRoot,
    pluginIdentity: identity,
    pluginEvidence: [{
      kind: "plugin",
      host: "fixture-host",
      marketplace: index === 0 ? "first" : "confirmed",
      plugin: "reviewer",
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  }));
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      effective_fingerprint: await fingerprintPath(versionOne),
      identity: generateLocalIdentity({
        skillName: "review",
        fingerprint: await fingerprintFile(path.join(versionOne, "SKILL.md")),
      }),
    },
  };
  const roots = rootsFor(versionOne, versionOneRoot);
  const discovery = await discoverFixtureSkills({ input: versionOne, roots, managerRecords: [] });
  const group = discovery.groups[0];
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: group.copies[0].path,
      owner: group.copies[0].owner,
    },
    interactive: true,
    confirmedProvenance: identities[1],
    confirmationEvidence: {
      actor: "human",
      reason: "selected the non-representative plugin identity",
    },
  });

  const binding = await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: versionOne,
    context: "global",
    statePath,
    roots,
    confirmedSelection,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.source.pluginIdentity, identities[1]);
  assert.deepEqual(binding.source.pluginCache, { kind: "versioned", scope: "global" });

  await rename(versionOneRoot, path.join(root, "removed"));
  await mkdir(versionTwo, { recursive: true });
  await writeFile(path.join(versionTwo, "SKILL.md"), workflow);
  const recovered = await resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootsFor(versionTwo, versionTwoRoot)[1]],
    managerRecords: [],
  });
  assert.equal(recovered.source.path, path.resolve(versionTwo));
  assert.equal(recovered.source.pluginIdentity, identities[1]);
  assert.deepEqual(recovered.source.pluginCache, { kind: "versioned", scope: "global" });
});

test("binding preserves a provenance choice made through a customization alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-customization-alias-"));
  const source = path.join(root, "review-fork");
  const alias = path.join(root, "installed-review-fork");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source);
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: review-fork\n---\ncustomized source\n",
  );
  await writeFile(path.join(source, "CUSTOMIZATION.md"), "Fork rationale.\n");
  const sourceDescriptor = {
    ...descriptor(),
    id: "urn:skill-customization:fixture:review-fork",
    name: "review-fork",
  };
  await writeFile(
    path.join(source, "customization.json"),
    JSON.stringify(sourceDescriptor),
  );
  await writeFile(
    path.join(source, ".skill-source.json"),
    JSON.stringify({
      source: {
        kind: "repository",
        repository: "https://github.com/other/skills",
        upstream_path: "review-fork/SKILL.md",
      },
    }),
  );
  await symlink(source, alias);
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(
    spawnSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/example/skills",
    ]).status,
    0,
  );
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  const discovery = await discoverFixtureSkills({ input: alias, roots, managerRecords: [] });
  const group = discovery.groups[0];
  assert.equal(group.conflict, true);
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: alias,
      owner: group.copies[0].owner,
    },
    interactive: true,
    confirmedProvenance:
      "repository:https://github.com/example/skills#review-fork/SKILL.md",
    confirmationEvidence: {
      actor: "human",
      reason: "selected the aliased customization with conflicting provenance",
    },
  });
  const outerDescriptor = {
    ...descriptor(),
    source: {
      skill_name: sourceDescriptor.name,
      kind: "customization",
      id: sourceDescriptor.id,
      type: sourceDescriptor.type,
      license: sourceDescriptor.license,
      effective_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  };
  const binding = await bindCustomization({
    descriptor: outerDescriptor,
    sourcePath: alias,
    context: "global",
    statePath,
    roots,
    managerRecords: [],
    confirmedSelection,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.source.selection.copy.path, alias);
  assert.equal(binding.source.selection.confirmation.path, alias);
  assert.equal(binding.source.target, await realpath(source));
  assert.equal(
    (
      await resolveBinding({
        descriptor: outerDescriptor,
        context: "global",
        statePath,
        roots,
        managerRecords: [],
      })
    ).source.selection.confirmation.path,
    alias,
  );
});

test("binding rejects the wrong upstream entrypoint in the expected repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-upstream-path-"));
  const source = path.join(root, "skills", "other");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nwrong path\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/skills"]).status,
    0,
  );

  await assert.rejects(
    bindCustomization({
      descriptor: descriptor(),
      sourcePath: source,
      context: "workspace",
      statePath: path.join(root, "bindings.json"),
      roots: [],
      requestedScope: "workspace",
      interactive: true,
      confirm: async () => true,
    }),
    (error) => error.code === "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
  );
});

test("resolution rechecks repository provenance and invalidates a changed source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-revalidate-repository-"));
  const source = path.join(root, "skills", "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/skills"]).status,
    0,
  );
  await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "workspace",
    statePath,
    roots: [],
    requestedScope: "workspace",
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(
    spawnSync("git", ["-C", root, "remote", "set-url", "origin", "https://github.com/other/skills"]).status,
    0,
  );

  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "workspace",
      statePath,
      roots: [],
    }),
    (error) => error.code === "BINDING_SOURCE_PROVENANCE_MISMATCH",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 0);
});

test("resolution invalidates a source that can no longer be fingerprinted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-revalidate-symlink-"));
  const source = path.join(root, "review");
  const replacement = path.join(root, "replacement", "review");
  const external = path.join(root, "external.md");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source);
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  await writeFile(path.join(replacement, "SKILL.md"), "---\nname: review\n---\nreplacement\n");
  await writeFile(external, "external\n");
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  await symlink(external, path.join(source, "helper.md"));

  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "global",
      statePath,
      roots,
    }),
    (error) => error.code === "BINDING_SOURCE_INVALID",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 0);

  const rebound = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: replacement,
    context: "global",
    statePath,
    roots: [{
      path: path.dirname(replacement),
      scope: "global",
      origin: "personal",
    }],
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(rebound.source.path, replacement);
});

test("resolution preserves a confirmed local binding across content drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-revalidate-local-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nlocal source\n");
  const fingerprint = await fingerprintFile(path.join(source, "SKILL.md"));
  const localDescriptor = {
    ...descriptor(),
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      effective_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      identity: generateLocalIdentity({ skillName: "review", fingerprint }),
    },
  };
  await bindCustomization({
    descriptor: localDescriptor,
    sourcePath: source,
    context: "global",
    statePath,
    roots: [{ path: root, scope: "global", origin: "personal" }],
    interactive: true,
    confirm: async () => true,
  });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nchanged local source\n");

  const resolved = await resolveBinding({
    descriptor: localDescriptor,
    context: "global",
    statePath,
    roots: [{ path: root, scope: "global", origin: "personal" }],
  });
  assert.equal(resolved.source.localIdentity, localDescriptor.source.identity);
  const validation = await validateBinding({
    descriptor: localDescriptor,
    binding: resolved,
    roots: [{ path: root, scope: "global", origin: "personal" }],
  });
  assert.notEqual(validation.inspection.fingerprint, resolved.source.fingerprint);
  assert.equal(validation.binding.source.localIdentity, localDescriptor.source.identity);
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 1);
});

test("binding validation rejects a repository binding after its reviewed source checkpoint drifts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-revalidate-repository-fingerprint-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nreviewed source\n");
  const baseDescriptor = descriptor();
  const repositoryDescriptor = {
    ...baseDescriptor,
    source: {
      ...baseDescriptor.source,
      effective_fingerprint: await fingerprintPath(source),
    },
  };
  const roots = [{ path: root, scope: "global", origin: "personal" }];
  await bindCustomization({
    descriptor: repositoryDescriptor,
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nchanged source\n");

  const binding = (await readBindingStore(statePath)).bindings[
    bindingKey(repositoryDescriptor.id, "global")
  ];
  await assert.rejects(
    validateBinding({
      descriptor: repositoryDescriptor,
      binding,
      roots,
    }),
    (error) => error.code === "BINDING_SOURCE_FINGERPRINT_MISMATCH",
  );
  await assert.rejects(
    validateBinding({
      descriptor: repositoryDescriptor,
      binding,
      roots,
      enforceReviewedFingerprint: false,
    }),
    (error) => error.code === "BINDING_SOURCE_FINGERPRINT_MISMATCH",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 1);
});

test("resolution rechecks the persisted source skill name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-revalidate-name-"));
  const source = path.join(root, "review");
  const statePath = path.join(root, "bindings.json");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots: [{ path: root, scope: "global", origin: "personal" }],
    interactive: true,
    confirm: async () => true,
  });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: other\n---\nsource\n");

  await assert.rejects(
    resolveBinding({
      descriptor: descriptor(),
      context: "global",
      statePath,
      roots: [{ path: root, scope: "global", origin: "personal" }],
    }),
    (error) => error.code === "BINDING_SOURCE_NAME_MISMATCH",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 0);
});
