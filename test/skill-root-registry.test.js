import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hostSkillRoots } from "../src/discovery.js";
import {
  normalizeSkillRootObservations,
  registrySkillRoots,
  SKILL_ROOT_REGISTRY,
  SKILL_ROOT_REGISTRY_CHECKPOINT,
} from "../src/skill-root-registry.js";

const CHECKPOINTED_OWNERS = [
  "adal",
  "amp",
  "antigravity",
  "augment",
  "claude-code",
  "cline",
  "codebuddy",
  "codex",
  "command-code",
  "continue",
  "cortex",
  "crush",
  "cursor",
  "droid",
  "gemini-cli",
  "github-copilot",
  "goose",
  "iflow-cli",
  "junie",
  "kilo",
  "kimi-cli",
  "kiro-cli",
  "kode",
  "mcpjam",
  "mistral-vibe",
  "mux",
  "neovate",
  "openclaw",
  "opencode",
  "openhands",
  "pi",
  "pochi",
  "qoder",
  "qwen-code",
  "replit",
  "roo",
  "trae",
  "trae-cn",
  "universal",
  "windsurf",
  "zencoder",
];

test("registry is pinned to the reviewed Vercel agent-path checkpoint", () => {
  assert.deepEqual(SKILL_ROOT_REGISTRY_CHECKPOINT, {
    repository: "https://github.com/vercel-labs/skills",
    revision: "305ff8be68e59368789d765e2cf0edfab851c453",
    file: "src/agents.ts",
  });
  assert.deepEqual(
    SKILL_ROOT_REGISTRY.filter((entry) => !entry.legacy)
      .map(({ owner }) => owner)
      .sort(),
    CHECKPOINTED_OWNERS,
  );
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(SKILL_ROOT_REGISTRY.filter((entry) => !entry.legacy)))
      .digest("hex"),
    "eabee9ac4b5fd5a603ed19cd4fba3ecf54d95def758e61be1f253f75d1eaeeff",
  );
});

test("every checkpointed project and global declaration resolves", () => {
  const home = "/fixture/home";
  const workspace = "/fixture/workspace";
  const roots = registrySkillRoots({
    home,
    workspaceDirectories: [workspace],
    env: {},
    pathExists: () => false,
  });
  for (const entry of SKILL_ROOT_REGISTRY) {
    const expectedProject = path.resolve(workspace, entry.project);
    assert.ok(
      roots.some((root) =>
        root.path === expectedProject
        && root.owner === entry.owner
        && root.scope === "workspace"),
      `${entry.owner} project root should resolve`,
    );
    if (!entry.global) continue;
    assert.ok(
      roots.some((root) => root.owner === entry.owner && root.scope === "global"),
      `${entry.owner} global root should resolve`,
    );
  }
});

test("registry honors XDG, Codex, Claude, and OpenClaw homes", () => {
  const home = "/fixture/home";
  const roots = registrySkillRoots({
    home,
    workspaceDirectories: [],
    env: {
      XDG_CONFIG_HOME: "/fixture/xdg",
      CODEX_HOME: "/fixture/codex",
      CLAUDE_CONFIG_DIR: "/fixture/claude",
    },
    pathExists: (candidate) => candidate === path.join(home, ".clawdbot"),
  });
  const globalPath = (owner) =>
    roots.find((root) => root.owner === owner && root.scope === "global")?.path;
  assert.equal(globalPath("amp"), "/fixture/xdg/agents/skills");
  assert.equal(globalPath("codex"), "/fixture/codex/skills");
  assert.equal(globalPath("claude-code"), "/fixture/claude/skills");
  assert.equal(globalPath("openclaw"), "/fixture/home/.clawdbot/skills");
});

test("OpenClaw resolution covers every checkpointed legacy home", () => {
  const home = "/fixture/home";
  for (const [existing, expected] of [
    [".openclaw", ".openclaw/skills"],
    [".clawdbot", ".clawdbot/skills"],
    [".moltbot", ".moltbot/skills"],
    [null, ".openclaw/skills"],
  ]) {
    const roots = registrySkillRoots({
      home,
      workspaceDirectories: [],
      env: {},
      pathExists: (candidate) =>
        existing !== null && candidate === path.join(home, existing),
    });
    assert.equal(
      roots.find((root) => root.owner === "openclaw")?.path,
      path.join(home, expected),
    );
  }
});

test("registry normalizes standard and configured root observations", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-"));
  try {
    const physical = path.join(fixture, "physical");
    const standardAlias = path.join(fixture, "workspace", ".agents", "skills");
    const configuredAlias = path.join(fixture, "configured", "skills");
    await mkdir(physical, { recursive: true });
    await mkdir(path.dirname(standardAlias), { recursive: true });
    await mkdir(path.dirname(configuredAlias), { recursive: true });
    await symlink(physical, standardAlias, "dir");
    await symlink(physical, configuredAlias, "dir");

    const result = normalizeSkillRootObservations([
      {
        kind: "standard",
        path: standardAlias,
        owner: "agents",
        scope: "workspace",
        origin: "project",
        registry: "legacy",
      },
      {
        kind: "configured",
        path: configuredAlias,
        owner: "claude-additional",
        scope: "workspace",
        origin: "host-added",
      },
    ]);

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roots, [{
      path: standardAlias,
      physicalPath: await realpath(physical),
      aliases: [standardAlias, configuredAlias],
      owner: "agents",
      owners: ["agents", "claude-additional"],
      scope: "workspace",
      origin: "project",
      registry: "legacy",
      registries: ["legacy"],
      active: true,
      singleSkill: false,
      includeRootSkill: true,
    }]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.roots), true);
    assert.equal(Object.isFrozen(result.roots[0]), true);
    assert.equal(Object.isFrozen(result.roots[0].aliases), true);

    assert.throws(
      () => result.roots.push({}),
      TypeError,
    );
    assert.throws(
      () => result.roots[0].owners.push("other"),
      TypeError,
    );

    const invalid = normalizeSkillRootObservations([{
      kind: "configured",
      path: "",
      owner: "claude-additional",
      scope: "workspace",
      origin: "host-added",
    }]);
    assert.deepEqual(invalid.roots, []);
    assert.deepEqual(invalid.diagnostics, [{
      code: "INVALID_ROOT_PATH",
      message: "skill root observation requires a non-empty path",
      observationIndex: 0,
    }]);

    const laterSource = normalizeSkillRootObservations([{
      kind: "plugin",
      path: standardAlias,
      owner: "plugin:claude-code",
      scope: "global",
      origin: "plugin",
      active: false,
    }]);
    assert.deepEqual(laterSource.diagnostics, []);
    assert.equal(laterSource.roots[0].active, false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry merges plugin and manager observations without promoting ownership", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-plugin-"));
  try {
    const physical = path.join(fixture, "plugin", "skills");
    const standardAlias = path.join(fixture, "workspace", ".agents", "skills");
    const managerAlias = path.join(fixture, "manager", "skills");
    await mkdir(physical, { recursive: true });
    await mkdir(path.dirname(standardAlias), { recursive: true });
    await mkdir(path.dirname(managerAlias), { recursive: true });
    await symlink(physical, standardAlias, "dir");
    await symlink(physical, managerAlias, "dir");

    const evidence = {
      kind: "plugin",
      host: "fixture",
      plugin: "reviewer",
      marketplace: "official",
      identity: "local:plugin:fixture:official:reviewer",
    };
    const result = normalizeSkillRootObservations([
      {
        kind: "standard",
        path: standardAlias,
        owner: "agents",
        scope: "workspace",
        origin: "project",
      },
      {
        kind: "plugin",
        path: physical,
        owner: "plugin:fixture",
        owners: ["plugin:fixture"],
        scope: "global",
        origin: "plugin",
        active: false,
        singleSkill: true,
        includeRootSkill: false,
        plugin: { host: "fixture", marketplace: "official", name: "reviewer" },
        pluginMetadata: { name: "reviewer", version: "1.0.0" },
        pluginIdentity: evidence.identity,
        pluginEvidence: [evidence],
        pluginRoot: path.join(fixture, "plugin"),
      },
      {
        kind: "manager",
        path: managerAlias,
        owner: "manager:asm",
        scope: "global",
        origin: "manager",
      },
    ]);

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.roots.length, 1);
    const [root] = result.roots;
    assert.equal(root.path, standardAlias);
    assert.equal(root.physicalPath, await realpath(physical));
    assert.deepEqual(root.aliases, [standardAlias, physical, managerAlias]);
    assert.equal(root.owner, "agents");
    assert.deepEqual(root.owners, ["agents", "plugin:fixture", "manager:asm"]);
    assert.equal(root.origin, "plugin");
    assert.equal(root.active, true);
    assert.equal(root.singleSkill, true);
    assert.equal(root.includeRootSkill, false);
    assert.equal(root.pluginIdentity, evidence.identity);
    assert.deepEqual(root.pluginIdentities, [evidence.identity]);
    assert.deepEqual(root.pluginEvidence, [evidence]);
    assert.deepEqual(root.pluginRoots, [path.join(fixture, "plugin")]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry keeps distinct plugin physical copies and audit copies visible", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-cache-"));
  try {
    const identity = "local:plugin:fixture:official:reviewer";
    const first = path.join(fixture, "cache", "1", "skills");
    const second = path.join(fixture, "cache", "2", "skills");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const observation = (root, active) => ({
      kind: "plugin",
      path: root,
      owner: "plugin:fixture",
      scope: "global",
      origin: "plugin",
      ...(active === undefined ? {} : { active }),
      pluginIdentity: identity,
      pluginEvidence: [{ kind: "plugin", identity }],
    });
    const result = normalizeSkillRootObservations([
      observation(first, false),
      observation(second, false),
    ]);

    assert.equal(result.roots.length, 2);
    assert.deepEqual(result.roots.map(({ active }) => active), [false, false]);
    assert.deepEqual(
      result.roots.map(({ pluginIdentity }) => pluginIdentity),
      [identity, identity],
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry clears audit state when an installed plugin observation wins", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-active-"));
  try {
    const root = path.join(fixture, "plugin", "skills");
    await mkdir(root, { recursive: true });
    const observation = (active) => ({
      kind: "plugin",
      path: root,
      owner: "plugin:fixture",
      scope: "global",
      origin: "plugin",
      active,
      pluginIdentity: "local:plugin:fixture:official:reviewer",
    });

    const result = normalizeSkillRootObservations([
      observation(false),
      observation(true),
    ]);

    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].active, undefined);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry keeps active state for conflicting plugin identities on one physical root", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-conflict-"));
  try {
    const root = path.join(fixture, "plugin", "skills");
    await mkdir(root, { recursive: true });
    const observation = (pluginIdentity, active, scope) => ({
      kind: "plugin",
      path: root,
      owner: "plugin:fixture",
      scope,
      origin: "plugin",
      active,
      pluginIdentity,
    });

    const result = normalizeSkillRootObservations([
      observation("local:plugin:fixture:official:catalog", false, "workspace"),
      observation("local:plugin:fixture:official:installed", true, "global"),
    ]);

    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].active, true);
    assert.equal(result.roots[0].scope, "workspace");
    assert.deepEqual(result.roots[0].pluginIdentities, [
      "local:plugin:fixture:official:catalog",
      "local:plugin:fixture:official:installed",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("registry keeps active state for plugin aliases on one physical root", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-root-registry-alias-"));
  try {
    const root = path.join(fixture, "plugin", "skills");
    const alias = path.join(fixture, "alias", "skills");
    await mkdir(root, { recursive: true });
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(root, alias, "dir");
    const pluginIdentity = "local:plugin:fixture:official:reviewer";
    const observation = (pathName, active, scope) => ({
      kind: "plugin",
      path: pathName,
      owner: "plugin:fixture",
      scope,
      origin: "plugin",
      active,
      pluginIdentity,
    });

    const result = normalizeSkillRootObservations([
      observation(root, false, "workspace"),
      observation(alias, true, "global"),
    ]);

    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].active, true);
    assert.equal(result.roots[0].scope, "workspace");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("host roots feed standard and configured observations through the registry", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "host-skill-roots-"));
  try {
    const home = path.join(fixture, "home");
    const workspace = path.join(fixture, "workspace");
    const physical = path.join(fixture, "physical");
    const standardAlias = path.join(workspace, ".agents", "skills");
    const configuredAlias = path.join(workspace, "configured", "skills");
    await mkdir(physical, { recursive: true });
    await mkdir(path.dirname(standardAlias), { recursive: true });
    await mkdir(path.dirname(configuredAlias), { recursive: true });
    await symlink(physical, standardAlias, "dir");
    await symlink(physical, configuredAlias, "dir");

    const record = hostSkillRoots({
      home,
      cwd: workspace,
      env: {},
      claudeSettings: { additionalDirectories: [configuredAlias] },
    }).find(({ path: rootPath }) => rootPath === standardAlias);

    assert.equal(record.owner, "agents");
    assert.equal(record.path, standardAlias);
    assert.equal(record.physicalPath, await realpath(physical));
    assert.deepEqual(record.aliases, [standardAlias, configuredAlias]);
    assert.equal(record.scope, "workspace");
    assert.equal(record.origin, "project");
    assert.deepEqual(record.registries, ["legacy", "vercel-skills"]);
    assert.equal(record.active, true);
    assert.equal(record.singleSkill, false);
    assert.equal(record.includeRootSkill, true);
    for (const owner of [
      "agents",
      "amp",
      "codex",
      "cursor",
      "github-copilot",
      "universal",
      "claude-additional",
    ]) {
      assert.ok(record.owners.includes(owner));
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("host roots keep a canonical owner and associate every shared-root owner", () => {
  const roots = hostSkillRoots({
    home: "/fixture/home",
    cwd: "/fixture/workspace",
    env: {},
  });
  const shared = roots.find(({ path: rootPath }) =>
    rootPath === "/fixture/workspace/.agents/skills",
  );
  assert.equal(shared.owner, "agents");
  for (const owner of ["amp", "codex", "cursor", "github-copilot", "universal"]) {
    assert.ok(shared.owners.includes(owner));
  }
  assert.equal(
    roots.filter(({ path: rootPath }) =>
      rootPath === "/fixture/workspace/.agents/skills").length,
    1,
  );
  assert.ok(roots.some(({ path: rootPath }) =>
    rootPath === "/fixture/workspace/.codex/skills"));
});
