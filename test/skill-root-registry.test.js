import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { hostSkillRoots } from "../src/discovery.js";
import {
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
