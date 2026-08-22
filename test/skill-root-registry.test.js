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
