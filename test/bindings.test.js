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
import {
  confirmDiscoverySelection,
  discoverSkills,
} from "../src/discovery.js";
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
  const pendingRecovery = resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(versionThree, "3")],
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    store.bindings[key] = concurrentBinding;
    await writeFile(statePath, `${JSON.stringify(store, null, 2)}\n`);
  } finally {
    await release();
  }

  const afterRace = await pendingRecovery;
  assert.equal(afterRace.source.path, path.resolve(concurrentSource));
  assert.deepEqual((await readBindingStore(statePath)).bindings[key], concurrentBinding);

  const versionFour = path.join(root, "plugin", "4", "skills", "review");
  await rename(path.join(root, "concurrent"), path.join(root, "removed-concurrent"));
  await mkdir(versionFour, { recursive: true });
  await writeFile(path.join(versionFour, "SKILL.md"), "---\nname: review\n---\nstable\n");
  const releaseDeletion = await acquireStateLock(statePath);
  const pendingDeletion = resolveBinding({
    descriptor: sourceDescriptor,
    context: "global",
    statePath,
    roots: [rootRecord(versionFour, "4")],
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const deletedStore = await readBindingStore(statePath);
    delete deletedStore.bindings[key];
    await writeFile(statePath, `${JSON.stringify(deletedStore, null, 2)}\n`);
  } finally {
    await releaseDeletion();
  }

  await assert.rejects(
    pendingDeletion,
    (error) => error.code === "BINDING_NOT_FOUND",
  );
  assert.deepEqual((await readBindingStore(statePath)).bindings, {});
});

test("ambient binding preserves plugin identity for cache recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "binding-ambient-plugin-continuity-"));
  const claudeHome = path.join(root, "claude");
  const pluginCacheRoot = path.join(
    claudeHome,
    "plugins",
    "cache",
    "fixture-marketplace",
    "reviewer",
  );
  const versionOneRoot = path.join(pluginCacheRoot, "1");
  const versionOne = path.join(versionOneRoot, "skills", "review");
  const versionTwoRoot = path.join(pluginCacheRoot, "2");
  const versionTwo = path.join(versionTwoRoot, "skills", "review");
  const statePath = path.join(root, "state", "bindings.json");
  const identity = "local:plugin:claude-code:fixture-marketplace:reviewer";
  const repository = "https://github.com/example/reviewer";
  const workflow = "---\nname: review\n---\nstable\n";
  await mkdir(versionOne, { recursive: true });
  await writeFile(path.join(versionOne, "SKILL.md"), workflow);
  await mkdir(path.join(versionOneRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(versionOneRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "reviewer", version: "1", repository }),
  );
  const sourceDescriptor = {
    ...descriptor(),
    source: {
      ...descriptor().source,
      repository,
      upstream_path: "skills/review/SKILL.md",
      effective_fingerprint: await fingerprintPath(versionOne),
    },
  };

  const ambientHomes = {
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: path.join(root, "codex"),
    CURSOR_HOME: path.join(root, "cursor"),
    GEMINI_CLI_HOME: path.join(root, "gemini"),
  };
  const previousHomes = Object.fromEntries(
    Object.keys(ambientHomes).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, ambientHomes);
  try {
    const discovery = await discoverSkills({
      input: versionOne,
      managerRecords: [],
    });
    const group = discovery.groups[0];
    const chosenCopy = group.copies.find((copy) => copy.pluginIdentity === identity);
    const confirmedSelection = confirmDiscoverySelection({
      discovery,
      choice: {
        name: group.name,
        fingerprint: group.fingerprint,
        path: chosenCopy.path,
        owner: chosenCopy.owner,
      },
      interactive: true,
      confirmedProvenance: `repository:${repository}`,
      confirmationEvidence: {
        actor: "human",
        reason: "selected ambient plugin provenance",
      },
    });
    const bound = await bindCustomization({
      descriptor: sourceDescriptor,
      sourcePath: versionOne,
      context: "global",
      statePath,
      requestedScope: "global",
      interactive: true,
      confirm: async () => true,
      confirmedSelection,
    });
    assert.equal(bound.source.pluginIdentity, identity);
    assert.deepEqual(bound.source.pluginCache, { kind: "versioned", scope: "global" });
    assert.equal(bound.source.selection.provenance, `repository:${repository}`);

    const validated = await resolveBinding({
      descriptor: sourceDescriptor,
      context: "global",
      statePath,
    });
    assert.equal(validated.source.path, path.resolve(versionOne));
    assert.equal(validated.source.selection.provenance, `repository:${repository}`);

    await rename(versionOneRoot, path.join(root, "removed"));
    await mkdir(versionTwo, { recursive: true });
    await writeFile(path.join(versionTwo, "SKILL.md"), workflow);
    await mkdir(path.join(versionTwoRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(versionTwoRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "reviewer", version: "2", repository }),
    );

    const resolved = await resolveBinding({
      descriptor: sourceDescriptor,
      context: "global",
      statePath,
    });
    assert.equal(resolved.source.path, path.resolve(versionTwo));
    assert.equal(resolved.source.pluginIdentity, identity);
    assert.deepEqual(resolved.source.pluginCache, { kind: "versioned", scope: "global" });
  } finally {
    for (const [name, value] of Object.entries(previousHomes)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  const directStatePath = path.join(root, "direct-state", "bindings.json");
  const directBinding = await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: directSource,
    context: "workspace-direct",
    statePath: directStatePath,
    roots: [rootRecord(directSource, "workspace")],
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(directBinding.source.pluginIdentity, identity);
  assert.equal(Object.hasOwn(directBinding.source, "pluginCache"), false);
  await rename(directSource, path.join(root, "removed-direct"));
  await mkdir(directReplacement, { recursive: true });
  await writeFile(path.join(directReplacement, "SKILL.md"), workflow);
  await assert.rejects(
    resolveBinding({
      descriptor: sourceDescriptor,
      context: "workspace-direct",
      statePath: directStatePath,
      roots: [rootRecord(directReplacement, "global")],
    }),
    (error) => error.code === "BINDING_TARGET_MISSING",
  );
  assert.deepEqual((await readBindingStore(directStatePath)).bindings, {});

  await mkdir(cacheSource, { recursive: true });
  await writeFile(path.join(cacheSource, "SKILL.md"), workflow);
  const cacheStatePath = path.join(root, "cache-state", "bindings.json");
  const cacheBinding = await bindCustomization({
    descriptor: sourceDescriptor,
    sourcePath: cacheSource,
    context: "workspace-cache",
    statePath: cacheStatePath,
    roots: [
      {
        path: cacheSource,
        owner: "workspace",
        scope: "workspace",
        origin: "project",
      },
      rootRecord(cacheSource, "workspace", true),
    ],
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(cacheBinding.source.pluginIdentity, identity);
  assert.deepEqual(cacheBinding.source.pluginCache, {
    kind: "versioned",
    scope: "workspace",
  });
  await rename(cacheSource, path.join(root, "removed-cache"));
  await mkdir(cacheReplacement, { recursive: true });
  await writeFile(path.join(cacheReplacement, "SKILL.md"), workflow);
  await assert.rejects(
    resolveBinding({
      descriptor: sourceDescriptor,
      context: "workspace-cache",
      statePath: cacheStatePath,
      roots: [rootRecord(cacheReplacement, "global", true)],
    }),
    (error) => error.code === "BINDING_TARGET_MISSING",
  );
  assert.deepEqual((await readBindingStore(cacheStatePath)).bindings, {});
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
  const recovered = await resolveBinding({
    descriptor: sourceDescriptor,
    context,
    statePath,
    roots: [rootRecord(versionTwo, "2")],
  });
  assert.equal(recovered.source.path, path.resolve(versionTwo));
  assert.equal(recovered.source.pluginIdentity, identity);
  assert.deepEqual(recovered.source.customization, bound.source.customization);
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
  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: alias,
    context: "/workspace",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(binding.scope, "workspace");
  assert.equal(binding.source.alias, alias);
  const canonicalTargetOne = await realpath(targetOne);
  assert.equal(binding.source.target, canonicalTargetOne);
  assert.equal((await resolveBinding({ descriptor: descriptor(), context: "/workspace", statePath })).source.target, canonicalTargetOne);

  await unlink(alias);
  await symlink(targetTwo, alias);
  await assert.rejects(
    resolveBinding({ descriptor: descriptor(), context: "/workspace", statePath }),
    (error) => error.code === "BINDING_RETARGETED",
  );
  assert.equal(Object.keys((await readBindingStore(statePath)).bindings).length, 0);
});

test("replacement binding requires a separate explicit confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-"));
  const source = path.join(root, "review");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "bindings.json"),
      roots: [{ path: root, scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => false,
      activeSkills: [{ name: "review", path: source }],
    }),
    (error) => error.code === "REPLACEMENT_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    bindCustomization({
      descriptor: descriptor({ mode: "replace", precedence: "customization-first" }),
      sourcePath: source,
      context: "global",
      statePath: path.join(root, "ambiguous-bindings.json"),
      roots: [{ path: root, scope: "global", origin: "personal" }],
      interactive: true,
      confirm: async () => true,
      confirmReplace: async () => true,
      activeSkills: [
        { name: "review", path: source },
        { name: "review", path: path.join(root, "other-review") },
      ],
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT",
  );
});

test("persisted replacement validation requires an unambiguous active inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replace-validation-"));
  const source = path.join(root, "review");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nsource\n");
  const replacement = descriptor({
    mode: "replace",
    precedence: "customization-first",
  });
  const activeSkills = [{ name: "review", path: source }];
  const binding = await bindCustomization({
    descriptor: replacement,
    sourcePath: source,
    context: "global",
    statePath: path.join(root, "bindings.json"),
    roots: [{ path: root, scope: "global", origin: "personal" }],
    interactive: true,
    confirm: async () => true,
    confirmReplace: async () => true,
    activeSkills,
  });

  await assert.rejects(
    validateBinding({ descriptor: replacement, binding }),
    (error) => error.code === "REPLACEMENT_INVENTORY_REQUIRED",
  );
  await assert.rejects(
    validateBinding({
      descriptor: replacement,
      binding,
      activeSkills: [
        ...activeSkills,
        { name: "review", path: path.join(root, "other-review") },
      ],
    }),
    (error) => error.code === "AMBIGUOUS_REPLACEMENT",
  );
  assert.equal(
    (await validateBinding({ descriptor: replacement, binding, activeSkills })).binding,
    binding,
  );
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
  const discovery = await discoverSkills({ input: source, roots, managerRecords });
  const group = discovery.groups[0];
  const chosenCopy = group.copies.find(({ owner }) => owner === "manager:asm");
  const confirmedSelection = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: chosenCopy.path,
      owner: chosenCopy.owner,
    },
    interactive: true,
    confirmedProvenance:
      "repository:https://github.com/example/skills#skills/review/SKILL.md",
    confirmationEvidence: {
      actor: "human",
      reason: "selected the ASM-owned repository source",
    },
  });

  const binding = await bindCustomization({
    descriptor: descriptor(),
    sourcePath: source,
    context: "global",
    statePath,
    roots,
    managerRecords,
    confirmedSelection,
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
  const discovery = await discoverSkills({ input: source, roots, managerRecords: [] });
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
  const discovery = await discoverSkills({ input: source, roots, managerRecords: [] });
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
  const discovery = await discoverSkills({ input: alias, roots, managerRecords: [] });
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
