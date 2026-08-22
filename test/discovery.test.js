import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeSkillInventory,
  confirmDiscoverySelection,
  configuredHostSkillRoots,
  discoverSkills,
  hostSkillRoots,
} from "../src/discovery.js";
import { fingerprintPath } from "../src/fingerprint.js";

async function writeSkill(root, folder, name = folder, body = "Use this skill.\n") {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\n${body}`,
  );
  return directory;
}

test("host roots include Codex, Claude additions, and Copilot env without a home crawl", async () => {
  const home = "/fixture/home";
  const roots = hostSkillRoots({
    home,
    cwd: "/fixture/workspace/project",
    env: { COPILOT_SKILLS_DIRS: "/opt/team-skills:/opt/other-skills" },
    claudeSettings: { additionalDirectories: ["/opt/claude-project"] },
  });
  const paths = roots.map((root) => root.path);
  assert.ok(paths.includes("/fixture/home/.codex/skills"));
  assert.ok(paths.includes("/fixture/home/.claude/skills"));
  assert.ok(paths.includes("/fixture/home/.copilot/skills"));
  assert.ok(paths.includes("/opt/team-skills"));
  assert.ok(paths.includes("/opt/claude-project/.claude/skills"));
  assert.equal(paths.some((value) => value === home), false);
});

test("ambient discovery finds Claude plugin cache roots with manifest provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-plugin-"));
  const home = path.join(root, "home");
  const pluginRoot = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "reviewer",
    "1.2.3",
  );
  const skill = await writeSkill(path.join(pluginRoot, "skills"), "review");
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "reviewer",
      version: "1.2.3",
      repository: "https://github.com/example/reviewer",
    }),
  );
  await writeFile(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "reviewer@official": [{ installPath: pluginRoot, version: "1.2.3" }],
      },
    }),
  );

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies[0].path, skill);
  assert.equal(result.groups[0].copies[0].owner, "plugin:claude-code");
  assert.equal(result.groups[0].copies[0].active, undefined);
  assert.deepEqual(activeSkillInventory(result), [
    { name: "review", path: skill, realPath: await realpath(skill) },
  ]);
  assert.deepEqual(result.groups[0].copies[0].plugin, {
    host: "claude-code",
    marketplace: "official",
    name: "reviewer",
    version: "1.2.3",
  });
  assert.deepEqual(
    result.groups[0].evidence.map(({ kind }) => kind),
    ["plugin"],
  );
  assert.deepEqual(result.groups[0].provenance, [
    "repository:https://github.com/example/reviewer",
  ]);
});

test("Claude project-scoped installs activate only inside their bound project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-project-plugin-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project-a");
  const foreignProject = path.join(root, "project-b");
  const pluginRoot = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "reviewer",
    "1.2.3",
  );
  const skill = await writeSkill(path.join(pluginRoot, "skills"), "review");
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "reviewer", version: "1.2.3" }),
  );
  await Promise.all([
    mkdir(path.join(project, "nested"), { recursive: true }),
    mkdir(foreignProject, { recursive: true }),
  ]);
  await writeFile(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "reviewer@official": [{
          scope: "project",
          projectPath: project,
          installPath: pluginRoot,
          version: "1.2.3",
        }],
      },
    }),
  );

  const active = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(project, "nested"),
    env: {},
    managerRecords: [],
  });
  assert.equal(active.groups[0].copies[0].scope, "workspace");
  assert.equal(active.groups[0].copies[0].active, undefined);
  assert.deepEqual(activeSkillInventory(active), [
    { name: "review", path: skill, realPath: await realpath(skill) },
  ]);

  const inactive = await discoverSkills({
    input: "review",
    home,
    cwd: foreignProject,
    env: {},
    managerRecords: [],
  });
  assert.equal(inactive.groups[0].copies[0].active, false);
  assert.deepEqual(activeSkillInventory(inactive), []);
});

test("multi-host installs select each host's own plugin manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-multi-host-plugin-"));
  const home = path.join(root, "home");
  const install = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "shared-plugin",
    "1.0.0",
  );
  const claudeSkill = await writeSkill(
    path.join(install, "claude-skills"),
    "claude-host-review",
  );
  const codexSkill = await writeSkill(
    path.join(install, "codex-skills"),
    "codex-host-review",
  );
  await mkdir(path.join(install, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "shared-plugin",
      skills: "claude-skills",
      repository: "https://github.com/example/claude-plugin",
    }),
  );
  await mkdir(path.join(install, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(install, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "shared-plugin",
      skills: "codex-skills",
      repository: "https://github.com/example/codex-plugin",
    }),
  );
  await mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "personal",
      plugins: [{
        name: "shared-plugin",
        source: {
          source: "local",
          path: install,
        },
      }],
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: path.join(home, ".codex") },
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));
  assert.ok(
    byName.has("claude-host-review"),
    `missing Claude-host skill; discovered: ${[...byName.keys()].join(", ")}`,
  );
  assert.ok(
    byName.has("codex-host-review"),
    `missing Codex-host skill; discovered: ${[...byName.keys()].join(", ")}`,
  );
  const claudeCopy = byName.get("claude-host-review").copies[0];
  const codexCopy = byName.get("codex-host-review").copies[0];

  assert.equal(claudeCopy.path, claudeSkill);
  assert.equal(claudeCopy.plugin.host, "claude-code");
  assert.match(claudeCopy.pluginMetadata.manifestPath, /\.claude-plugin[\\/]plugin\.json$/);
  assert.deepEqual(byName.get("claude-host-review").provenance, [
    "repository:https://github.com/example/claude-plugin",
  ]);
  assert.equal(codexCopy.path, codexSkill);
  assert.equal(codexCopy.plugin.host, "codex");
  assert.match(codexCopy.pluginMetadata.manifestPath, /\.codex-plugin[\\/]plugin\.json$/);
  assert.deepEqual(byName.get("codex-host-review").provenance, [
    "repository:https://github.com/example/codex-plugin",
  ]);
});

test("ambient plugin discovery is opt-out and explicit roots remain authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-policy-"));
  const home = path.join(root, "home");
  await writeSkill(
    path.join(home, ".claude", "plugins", "cache", "official", "reviewer", "1", "skills"),
    "review",
  );

  const disabled = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    includePlugins: false,
    managerRecords: [],
  });
  assert.equal(disabled.groups.length, 0);
  assert.equal(disabled.searchedRoots.some(({ owner }) => owner.startsWith("plugin:")), false);

  const explicit = await discoverSkills({
    roots: [],
    additionalRoots: [path.join(home, ".claude", "plugins")],
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(explicit.groups.length, 0);
  assert.equal(explicit.searchedRoots.length, 0);
});

test("Claude sync discovery is gated and manifest directories stay bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-bounded-"));
  const home = path.join(root, "home");
  const pluginRoot = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "team",
    "custom",
    "1",
  );
  await writeSkill(path.join(pluginRoot, "custom-skills"), "manifest-review");
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "custom",
      skills: ["custom-skills", "../outside"],
    }),
  );
  await writeSkill(
    path.join(home, ".claude", "skills", "synced"),
    "synced-review",
  );
  await writeSkill(path.join(home, "unlisted"), "home-only");

  await assert.rejects(
    discoverSkills({
      input: "synced-review",
      home,
      cwd: path.join(root, "workspace"),
      env: {},
      managerRecords: [],
    }),
    (error) => error.code === "NO_LOCAL_COPY",
  );

  const result = await discoverSkills({
    input: "manifest-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CLAUDE_CODE_SYNC_SKILLS: "1" },
    managerRecords: [],
  });
  assert.equal(result.groups[0].name, "manifest-review");
  assert.equal(result.groups[0].copies[0].plugin.name, "custom");
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_ESCAPE"));
  assert.equal(result.groups.some(({ name }) => name === "home-only"), false);

  const synced = await discoverSkills({
    input: "synced-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CLAUDE_CODE_SYNC_SKILLS: "1" },
    managerRecords: [],
  });
  assert.equal(synced.groups[0].copies[0].plugin.marketplace, "synced");
});

test("Claude synced skills remain discoverable when no plugin cache exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-sync-only-"));
  const home = path.join(root, "home");
  await writeSkill(path.join(home, ".claude", "skills", "synced"), "sync-only");

  const result = await discoverSkills({
    input: "sync-only",
    home,
    cwd: path.join(root, "workspace"),
    env: { CLAUDE_CODE_SYNC_SKILLS: "1" },
    managerRecords: [],
  });
  assert.equal(result.groups[0].name, "sync-only");
});

test("invalid plugin siblings and escaping aliases are isolated from valid candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-diagnostics-"));
  const home = path.join(root, "home");
  const cache = path.join(home, ".claude", "plugins", "cache", "team");
  const valid = path.join(cache, "valid", "1");
  const malformed = path.join(cache, "malformed", "1");
  await writeSkill(path.join(valid, "skills"), "valid-review");
  await mkdir(path.join(valid, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(valid, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "valid" }),
  );
  await writeSkill(path.join(malformed, "skills"), "malformed-review");
  await mkdir(path.join(malformed, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(malformed, ".claude-plugin", "plugin.json"), "{broken\n");
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(cache, "escaped"), "dir");

  const result = await discoverSkills({
    input: "valid-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(result.groups[0].name, "valid-review");
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_METADATA"));
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_ESCAPE"));
});

test("plugin host roots require canonical containment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-host-alias-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, "codex");
  const outsidePlugins = path.join(root, "outside-plugins");
  await writeSkill(path.join(outsidePlugins, "untrusted", "skills"), "escaped-host");
  await mkdir(codexHome, { recursive: true });
  await symlink(outsidePlugins, path.join(codexHome, "plugins"), "dir");

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });
  assert.equal(result.groups.length, 0);
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_ESCAPE"));
});

test("ambient discovery honors Codex, Gemini, Cursor, and bounded workspace plugin layouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-hosts-"));
  const home = path.join(root, "home");
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "packages", "app");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const codexCache = path.join(
    home,
    ".codex",
    "plugins",
    "cache",
    "market",
    "codex-plugin",
    "2",
    "skills",
  );
  await writeSkill(codexCache, "codex-review");
  const workspacePlugin = path.join(repository, ".agents", "plugins", "local-plugin");
  await writeSkill(path.join(workspacePlugin, "custom"), "workspace-review");
  await mkdir(path.dirname(workspacePlugin), { recursive: true });
  await writeFile(
    path.join(repository, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "workspace-market",
      plugins: [
        { name: "invalid-plugin", path: { directory: "../outside" } },
        { name: "local-plugin", path: "./local-plugin", skills: ["custom"] },
      ],
    }),
  );

  const gemini = path.join(home, ".gemini", "extensions", "gemini-plugin");
  await writeSkill(path.join(gemini, "skills"), "gemini-review");
  await writeFile(
    path.join(gemini, "gemini-extension.json"),
    JSON.stringify({
      name: "gemini-plugin",
      version: "1.0.0",
      repository: "https://github.com/example/gemini-plugin",
    }),
  );

  const cursor = path.join(home, ".cursor", "plugins", "local", "cursor-plugin");
  await writeSkill(path.join(cursor, "skills"), "cursor-review");
  await mkdir(path.join(cursor, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(cursor, ".cursor-plugin", "plugin.json"),
    JSON.stringify({ name: "cursor-plugin" }),
  );
  const cursorLocal = path.join(home, ".cursor", "plugins", "local");
  const declaredCursor = path.join(cursorLocal, "declared-plugin");
  await writeSkill(path.join(declaredCursor, "custom"), "cursor-manifest-review");
  await mkdir(path.join(declaredCursor, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(declaredCursor, ".cursor-plugin", "plugin.json"),
    JSON.stringify({ name: "declared-plugin" }),
  );
  await writeFile(
    path.join(cursorLocal, "marketplace.json"),
    JSON.stringify({
      name: "cursor-local-marketplace",
      owner: { name: "fixture" },
      plugins: [{
        name: "declared-plugin",
        path: "./declared-plugin",
        skills: ["custom"],
        repository: { type: "git", url: "git+https://github.com/example/cursor-plugin.git" },
      }],
    }),
  );
  const unlistedWorkspacePlugin = path.join(repository, ".agents", "plugins", "unlisted");
  await writeSkill(unlistedWorkspacePlugin, "unlisted-plugin-review");

  const discovery = await discoverSkills({
    home,
    cwd: nested,
    env: {},
    managerRecords: [],
  });
  const byName = new Map(discovery.groups.map((group) => [group.name, group]));
  assert.equal(byName.get("codex-review").copies[0].plugin.host, "codex");
  assert.equal(byName.get("workspace-review").copies[0].plugin.marketplace, "workspace-market");
  assert.equal(byName.get("gemini-review").copies[0].plugin.host, "gemini-cli");
  assert.equal(byName.get("cursor-review").copies[0].plugin.host, "cursor");
  assert.equal(byName.get("cursor-manifest-review").copies[0].plugin.host, "cursor");
  assert.deepEqual(byName.get("cursor-manifest-review").provenance, [
    "repository:https://github.com/example/cursor-plugin",
  ]);
  assert.equal(byName.has("unlisted-plugin-review"), false);
  assert.ok(discovery.pluginDiagnostics.some(({ code }) => code === "PLUGIN_DECLARATION_INVALID_PATH"));
  assert.deepEqual(byName.get("gemini-review").provenance, [
    "repository:https://github.com/example/gemini-plugin",
  ]);
});

test("Cursor local plugins honor documented manifests and marketplace roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-local-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const agentPlugin = path.join(localRoot, "agent-plugin");
  const agentSkill = await writeSkill(agentPlugin, "prompts", "cursor-agent-review");
  await writeSkill(agentPlugin, "skills", "cursor-fallback-review");
  await writeFile(
    path.join(agentPlugin, "plugin.json"),
    JSON.stringify({
      name: "agent-plugin",
      skills: "prompts",
      repository: "https://github.com/example/agent-plugin",
    }),
  );

  const rootSkillPlugin = path.join(localRoot, "root-skill-plugin");
  await mkdir(rootSkillPlugin, { recursive: true });
  await writeFile(
    path.join(rootSkillPlugin, "SKILL.md"),
    "---\nname: cursor-root-review\ndescription: Fixture\n---\nUse this skill.\n",
  );
  await writeFile(
    path.join(rootSkillPlugin, "plugin.json"),
    JSON.stringify({ name: "root-skill-plugin" }),
  );

  const nestedMarketplaceRoot = path.join(localRoot, "nested-marketplace");
  const nestedMarketplacePlugin = path.join(nestedMarketplaceRoot, "nested-plugin");
  const nestedMarketplaceSkill = await writeSkill(
    path.join(nestedMarketplacePlugin, "skills"),
    "cursor-nested-review",
  );
  await mkdir(path.join(nestedMarketplaceRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(nestedMarketplaceRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "nested-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "nested-entry", source: "nested-plugin" }],
    }),
  );
  await mkdir(path.join(nestedMarketplacePlugin, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(nestedMarketplacePlugin, ".cursor-plugin", "plugin.json"),
    JSON.stringify({ name: "nested-plugin" }),
  );

  const defaultRootSkillPlugin = path.join(localRoot, "default-root-skill-plugin");
  await mkdir(path.join(defaultRootSkillPlugin, "skills"), { recursive: true });
  await writeFile(
    path.join(defaultRootSkillPlugin, "skills", "SKILL.md"),
    "---\nname: cursor-undocumented-default-review\ndescription: Fixture\n---\nUse this skill.\n",
  );
  await writeFile(
    path.join(defaultRootSkillPlugin, "plugin.json"),
    JSON.stringify({ name: "default-root-skill-plugin" }),
  );

  const marketplaceRoot = localRoot;
  const marketplacePlugin = path.join(marketplaceRoot, "plugins", "market-plugin");
  const marketplaceSkill = await writeSkill(
    marketplacePlugin,
    "custom-skills",
    "cursor-market-review",
  );
  await writeSkill(
    marketplacePlugin,
    "marketplace-skills",
    "cursor-marketplace-only-review",
  );
  await mkdir(path.join(marketplaceRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team-marketplace",
      owner: { name: "fixture" },
      metadata: { pluginRoot: "plugins" },
      plugins: [{
        name: "marketplace-entry-name",
        source: "market-plugin",
        version: "9.9.9",
        repository: "https://github.com/example/marketplace-entry",
        upstream_path: "marketplace/review",
        skills: "marketplace-skills",
      }],
    }),
  );
  await mkdir(path.join(marketplacePlugin, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(marketplacePlugin, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "market-plugin",
      version: "1.2.3",
      skills: "custom-skills",
      repository: "https://github.com/example/market-plugin",
      upstream_path: "skills/review",
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));
  assert.equal(byName.get("cursor-agent-review").copies[0].path, agentSkill);
  assert.deepEqual(byName.get("cursor-agent-review").provenance, [
    "repository:https://github.com/example/agent-plugin",
  ]);
  assert.equal(byName.has("cursor-fallback-review"), false);
  assert.equal(byName.get("cursor-root-review").copies[0].path, rootSkillPlugin);
  assert.equal(byName.get("cursor-nested-review").copies[0].path, nestedMarketplaceSkill);
  assert.equal(byName.get("cursor-market-review").copies[0].path, marketplaceSkill);
  assert.deepEqual(byName.get("cursor-market-review").copies[0].pluginMetadata, {
    host: "cursor",
    marketplace: "team-marketplace",
    name: "market-plugin",
    version: "1.2.3",
    root: marketplacePlugin,
    manifestPath: path.join(marketplacePlugin, ".cursor-plugin", "plugin.json"),
    source: "marketplace",
  });
  assert.deepEqual(byName.get("cursor-market-review").provenance, [
    "repository:https://github.com/example/market-plugin#skills/review/SKILL.md",
  ]);
  assert.equal(
    byName.get("cursor-market-review").copies[0].evidence[0].upstream_path,
    "skills/review/SKILL.md",
  );
  assert.equal(byName.has("cursor-marketplace-only-review"), false);
  assert.equal(byName.has("cursor-undocumented-default-review"), false);
});

test("Cursor skips marketplace entries when the declared plugin root is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-invalid-plugin-root-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const plugin = path.join(localRoot, "declared-plugin");
  await writeSkill(path.join(plugin, "skills"), "direct-review");
  await writeFile(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "declared-plugin" }),
  );
  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  const marketplacePath = path.join(localRoot, ".cursor-plugin", "marketplace.json");
  await writeFile(
    marketplacePath,
    JSON.stringify({
      name: "team-marketplace",
      owner: { name: "fixture" },
      metadata: { pluginRoot: 42 },
      plugins: [{ name: "marketplace-entry", source: "declared-plugin" }],
    }),
  );

  const result = await discoverSkills({
    input: "direct-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].conflict, false);
  assert.equal(result.groups[0].copies[0].plugin.marketplace, "local");
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_INVALID_ROOT"
      && diagnosticPath === marketplacePath,
  ));
});

test("Cursor root marketplaces own every in-root alias of declared plugins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-marketplace-owner-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const plugin = path.join(localRoot, "owned-plugin");
  await writeSkill(path.join(plugin, "skills"), "owned-review");
  await writeFile(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "owned-plugin" }),
  );
  const alias = path.join(localRoot, "owned-alias");
  await symlink(plugin, alias, "dir");
  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "owned-plugin", source: "owned-alias" }],
    }),
  );

  const result = await discoverSkills({
    input: "owned-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].conflict, false);
  assert.deepEqual(result.groups[0].copies[0].plugin, {
    host: "cursor",
    marketplace: "team-marketplace",
    name: "owned-plugin",
  });
  assert.deepEqual(result.groups[0].provenance, [
    "local:plugin:cursor:team-marketplace:owned-plugin",
  ]);
});

test("Cursor marketplace ownership survives declarations that emit no roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-empty-roots-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const plugin = path.join(localRoot, "owned-plugin");
  await writeSkill(path.join(plugin, "skills"), "owned-review");
  await writeFile(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "owned-plugin" }),
  );
  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "owned-plugin", source: "owned-plugin", skills: [] }],
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.some(({ name }) => name === "owned-review"), false);
});

test("Cursor marketplace plugin roots bound every declared entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-plugin-boundary-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const ownedPlugin = path.join(localRoot, "plugins", "owned-plugin");
  const outsidePlugin = path.join(localRoot, "outside-plugin");
  await writeSkill(path.join(ownedPlugin, "skills"), "owned-boundary-review");
  await writeSkill(path.join(outsidePlugin, "skills"), "outside-boundary-review");
  for (const [plugin, name] of [
    [ownedPlugin, "owned-plugin"],
    [outsidePlugin, "outside-plugin"],
  ]) {
    await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ name }));
  }
  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team-marketplace",
      owner: { name: "fixture" },
      metadata: { pluginRoot: "plugins" },
      plugins: [
        { name: "owned-plugin", source: "owned-plugin" },
        { name: "outside-plugin", source: "../outside-plugin" },
      ],
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));

  assert.equal(
    byName.get("owned-boundary-review").copies[0].plugin.marketplace,
    "team-marketplace",
  );
  assert.equal(
    byName.get("outside-boundary-review").copies[0].plugin.marketplace,
    "local",
  );
  assert.equal(byName.get("outside-boundary-review").conflict, false);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE" && diagnosticPath === outsidePlugin,
  ));
});

test("Cursor marketplace discovery ignores foreign host manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-host-marketplace-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const cursorPlugin = path.join(localRoot, "cursor-plugin");
  const foreignPlugin = path.join(localRoot, "foreign-plugin");
  await writeSkill(path.join(cursorPlugin, "skills"), "cursor-owned-review");
  await writeSkill(path.join(foreignPlugin, "skills"), "foreign-local-review");
  for (const [plugin, name] of [
    [cursorPlugin, "cursor-plugin"],
    [foreignPlugin, "foreign-plugin"],
  ]) {
    await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ name }));
  }
  await mkdir(path.join(localRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "foreign-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "foreign-plugin", source: "foreign-plugin" }],
    }),
  );
  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "cursor-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "cursor-plugin", source: "cursor-plugin" }],
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));

  assert.equal(byName.get("cursor-owned-review").copies[0].plugin.marketplace, "cursor-marketplace");
  assert.equal(byName.get("foreign-local-review").copies[0].plugin.marketplace, "local");
  assert.equal(byName.get("foreign-local-review").conflict, false);
});

test("Cursor manifests honor nested skill directory declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-nested-skills-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const expected = new Map();
  for (const container of ["layout", "components"]) {
    const plugin = path.join(localRoot, `${container}-plugin`);
    const skillDirectory = `${container}-skills`;
    const skillName = `${container}-nested-review`;
    expected.set(skillName, await writeSkill(path.join(plugin, skillDirectory), skillName));
    await mkdir(path.join(plugin, ".cursor-plugin"), { recursive: true });
    await writeFile(
      path.join(plugin, ".cursor-plugin", "plugin.json"),
      JSON.stringify({
        name: `${container}-plugin`,
        [container]: { skills: skillDirectory },
      }),
    );
  }

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));

  for (const [name, skillPath] of expected) {
    assert.equal(byName.get(name).copies[0].path, skillPath);
    assert.equal(byName.get(name).copies[0].plugin.name, `${name.split("-")[0]}-plugin`);
  }
});

test("Cursor plugin diagnostics isolate invalid manifests, paths, and aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-diagnostics-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const validPlugin = path.join(localRoot, "valid-plugin");
  const validSkill = await writeSkill(path.join(validPlugin, "safe"), "valid-review");
  const outsideSkill = path.join(root, "outside-skill");
  await writeSkill(outsideSkill, "escaped-declared-review");
  await symlink(outsideSkill, path.join(validPlugin, "linked"), "dir");
  await mkdir(path.join(validPlugin, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(validPlugin, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "valid-plugin",
      skills: ["safe", 42, "../outside-skill", "linked"],
    }),
  );

  const malformedPlugin = path.join(localRoot, "malformed-plugin");
  await writeSkill(path.join(malformedPlugin, "skills"), "malformed-review");
  await mkdir(path.join(malformedPlugin, ".cursor-plugin"), { recursive: true });
  await writeFile(path.join(malformedPlugin, ".cursor-plugin", "plugin.json"), "{broken\n");
  await writeFile(
    path.join(malformedPlugin, "plugin.json"),
    JSON.stringify({ name: "malformed-plugin" }),
  );

  const invalidPlugin = path.join(localRoot, "invalid-plugin");
  await writeSkill(path.join(invalidPlugin, "skills"), "invalid-review");
  await writeFile(
    path.join(invalidPlugin, "plugin.json"),
    JSON.stringify({ name: 42 }),
  );

  const invalidNamePlugin = path.join(localRoot, "invalid-name-plugin");
  await writeSkill(path.join(invalidNamePlugin, "skills"), "invalid-name-review");
  await writeFile(
    path.join(invalidNamePlugin, "plugin.json"),
    JSON.stringify({ name: " invalid-name-plugin " }),
  );

  const escapingMarketplacePlugin = path.join(localRoot, "escaping-marketplace-plugin");
  await writeSkill(
    path.join(escapingMarketplacePlugin, "skills"),
    "cursor-escaping-marketplace-review",
  );
  await mkdir(path.join(escapingMarketplacePlugin, ".cursor-plugin"), { recursive: true });
  const outsideMarketplaceManifest = path.join(root, "outside-marketplace.json");
  await writeFile(
    outsideMarketplaceManifest,
    JSON.stringify({ name: "outside-marketplace", plugins: [] }),
  );
  await symlink(
    outsideMarketplaceManifest,
    path.join(escapingMarketplacePlugin, ".cursor-plugin", "marketplace.json"),
    "file",
  );
  await writeFile(
    path.join(escapingMarketplacePlugin, "plugin.json"),
    JSON.stringify({ name: "escaping-marketplace-plugin" }),
  );

  const escapingSkillsRootPlugin = path.join(localRoot, "escaping-skills-root-plugin");
  await mkdir(escapingSkillsRootPlugin, { recursive: true });
  await writeFile(
    path.join(escapingSkillsRootPlugin, "SKILL.md"),
    "---\nname: cursor-root-after-escape\ndescription: Fixture\n---\nUse this skill.\n",
  );
  const outsideSkillsRoot = path.join(root, "outside-skills-root");
  await writeFile(outsideSkillsRoot, "not a directory\n");
  await symlink(
    outsideSkillsRoot,
    path.join(escapingSkillsRootPlugin, "skills"),
    "file",
  );
  await writeFile(
    path.join(escapingSkillsRootPlugin, "plugin.json"),
    JSON.stringify({ name: "escaping-skills-root-plugin" }),
  );

  const brokenMarketplacePlugin = path.join(localRoot, "broken-marketplace-plugin");
  await writeSkill(
    path.join(brokenMarketplacePlugin, "skills"),
    "cursor-broken-marketplace-review",
  );
  await mkdir(path.join(brokenMarketplacePlugin, ".cursor-plugin"), { recursive: true });
  const brokenMarketplacePath = path.join(
    brokenMarketplacePlugin,
    ".cursor-plugin",
    "marketplace.json",
  );
  await writeFile(
    brokenMarketplacePath,
    JSON.stringify({ name: "broken_marketplace" }),
  );
  await writeFile(
    path.join(brokenMarketplacePlugin, "plugin.json"),
    JSON.stringify({ name: "broken-marketplace-plugin" }),
  );

  const invalidEntryMarketplacePlugin = path.join(
    localRoot,
    "invalid-entry-marketplace-plugin",
  );
  await writeSkill(
    path.join(invalidEntryMarketplacePlugin, "skills"),
    "cursor-invalid-entry-fallback-review",
  );
  await mkdir(path.join(invalidEntryMarketplacePlugin, ".cursor-plugin"), { recursive: true });
  const invalidEntryMarketplacePath = path.join(
    invalidEntryMarketplacePlugin,
    ".cursor-plugin",
    "marketplace.json",
  );
  await writeFile(
    invalidEntryMarketplacePath,
    JSON.stringify({
      name: "invalid-entry-marketplace",
      owner: { name: "fixture" },
      plugins: [{ name: "BAD_NAME", source: "missing-plugin" }],
    }),
  );
  await writeFile(
    path.join(invalidEntryMarketplacePlugin, "plugin.json"),
    JSON.stringify({ name: "invalid-entry-marketplace-plugin" }),
  );

  const tooManyEntriesPlugin = path.join(localRoot, "too-many-entries-plugin");
  await writeSkill(
    path.join(tooManyEntriesPlugin, "skills"),
    "cursor-too-many-entries-fallback-review",
  );
  await mkdir(path.join(tooManyEntriesPlugin, ".cursor-plugin"), { recursive: true });
  const tooManyEntriesMarketplacePath = path.join(
    tooManyEntriesPlugin,
    ".cursor-plugin",
    "marketplace.json",
  );
  await writeFile(
    tooManyEntriesMarketplacePath,
    JSON.stringify({
      name: "too-many-entries-marketplace",
      owner: { name: "fixture" },
      plugins: Array.from({ length: 501 }, (_, index) => ({
        name: `plugin-${index}`,
        source: `missing-plugin-${index}`,
      })),
    }),
  );
  await writeFile(
    path.join(tooManyEntriesPlugin, "plugin.json"),
    JSON.stringify({ name: "too-many-entries-plugin" }),
  );

  const escapingRootSkillPlugin = path.join(localRoot, "escaping-root-skill-plugin");
  await mkdir(escapingRootSkillPlugin, { recursive: true });
  const outsideRootSkill = path.join(root, "outside-root-skill.md");
  await writeFile(
    outsideRootSkill,
    "---\nname: cursor-escaping-root-review\ndescription: Fixture\n---\nUse this skill.\n",
  );
  const escapingRootSkillPath = path.join(escapingRootSkillPlugin, "SKILL.md");
  await symlink(outsideRootSkill, escapingRootSkillPath, "file");
  await writeFile(
    path.join(escapingRootSkillPlugin, "plugin.json"),
    JSON.stringify({ name: "escaping-root-skill-plugin" }),
  );

  const defaultEscapingPlugin = path.join(localRoot, "default-escaping-plugin");
  const defaultOutsideSkill = await writeSkill(
    root,
    "default-outside-skill",
    "default-escaped-review",
  );
  await mkdir(path.join(defaultEscapingPlugin, "skills"), { recursive: true });
  await symlink(
    defaultOutsideSkill,
    path.join(defaultEscapingPlugin, "skills", "linked"),
    "dir",
  );
  await writeFile(
    path.join(defaultEscapingPlugin, "plugin.json"),
    JSON.stringify({ name: "default-escaping-plugin" }),
  );

  const emptySkillsPlugin = path.join(localRoot, "empty-skills-plugin");
  await writeSkill(path.join(emptySkillsPlugin, "skills"), "empty-fallback-review");
  await writeFile(
    path.join(emptySkillsPlugin, "plugin.json"),
    JSON.stringify({ name: "empty-skills-plugin", skills: [] }),
  );

  const invalidSkillsPlugin = path.join(localRoot, "invalid-skills-plugin");
  await writeSkill(path.join(invalidSkillsPlugin, "skills"), "invalid-fallback-review");
  await writeFile(
    path.join(invalidSkillsPlugin, "plugin.json"),
    JSON.stringify({ name: "invalid-skills-plugin", skills: 42 }),
  );

  const outside = path.join(root, "outside");
  await writeSkill(outside, "escaped-review");
  await symlink(outside, path.join(localRoot, "escaped-plugin"), "dir");

  await mkdir(path.join(localRoot, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(localRoot, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "invalid-marketplace",
      owner: { name: "fixture" },
      metadata: { pluginRoot: "../outside-marketplace" },
      plugins: [{ name: "escaped-market", source: "plugin" }],
    }),
  );

  const result = await discoverSkills({
    input: "valid-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(result.groups[0].copies[0].path, validSkill);
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_METADATA"));
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "INVALID_PLUGIN_METADATA"));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, message }) => code === "INVALID_PLUGIN_METADATA" && message.includes("invalid plugin name"),
  ));
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_ESCAPE"));
  assert.ok(result.pluginDiagnostics.some(({ code }) => code === "PLUGIN_SKILL_DIRECTORY_INVALID"));
  assert.equal(result.groups.some(({ name }) => name === "escaped-review"), false);
  assert.equal(result.groups.some(({ name }) => name === "default-escaped-review"), false);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE"
      && diagnosticPath === path.join(defaultEscapingPlugin, "skills", "linked"),
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_METADATA_ESCAPE"
      && diagnosticPath === path.join(
        escapingMarketplacePlugin,
        ".cursor-plugin",
        "marketplace.json",
      ),
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE"
      && diagnosticPath === path.join(escapingSkillsRootPlugin, "skills"),
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_INVALID_NAME"
      && diagnosticPath === brokenMarketplacePath,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_INVALID_OWNER"
      && diagnosticPath === brokenMarketplacePath,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_MISSING_ENTRIES"
      && diagnosticPath === brokenMarketplacePath,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_DECLARATION_INVALID_NAME"
      && diagnosticPath === invalidEntryMarketplacePath,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_TOO_MANY_ENTRIES"
      && diagnosticPath === tooManyEntriesMarketplacePath,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE"
      && diagnosticPath === escapingRootSkillPath,
  ));

  const escapedMarketplacePath = path.join(
    home,
    ".cursor",
    "plugins",
    "outside-marketplace",
  );
  assert.ok(result.pluginDiagnostics.some(
    ({ host, code, path: diagnosticPath }) =>
      host === "cursor"
      && code === "PLUGIN_ROOT_ESCAPE"
      && diagnosticPath === escapedMarketplacePath,
  ));
  const inventory = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(inventory.groups.some(({ name }) => name === "empty-fallback-review"), false);
  assert.equal(inventory.groups.some(({ name }) => name === "invalid-fallback-review"), false);
  assert.equal(inventory.groups.some(({ name }) => name === "malformed-review"), false);
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-escaping-marketplace-review"),
    true,
  );
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-root-after-escape"),
    false,
  );
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-broken-marketplace-review"),
    true,
  );
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-invalid-entry-fallback-review"),
    true,
  );
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-too-many-entries-fallback-review"),
    true,
  );
  assert.equal(
    inventory.groups.some(({ name }) => name === "cursor-escaping-root-review"),
    false,
  );
});

test("Gemini CLI discovers configured user and bounded workspace extensions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-gemini-configured-"));
  const fallbackHome = path.join(root, "fallback-home");
  const configuredHome = path.join(root, "configured-home");
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "packages", "app");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });

  const globalExtension = path.join(
    configuredHome,
    ".gemini",
    "extensions",
    "global-extension",
  );
  const globalSkill = await writeSkill(
    path.join(globalExtension, "skills"),
    "configured-gemini-review",
  );
  await writeFile(
    path.join(globalExtension, "gemini-extension.json"),
    JSON.stringify({
      name: "global-extension",
      version: "1.0.0",
      repository: "https://github.com/example/global-extension",
    }),
  );

  const workspaceExtension = path.join(
    repository,
    ".gemini",
    "extensions",
    "workspace-extension",
  );
  const workspaceSkill = await writeSkill(
    path.join(workspaceExtension, "skills"),
    "workspace-gemini-review",
  );
  await writeFile(
    path.join(workspaceExtension, "gemini-extension.json"),
    JSON.stringify({
      name: "workspace-extension",
      version: "2.0.0",
    }),
  );

  const options = {
    home: fallbackHome,
    cwd: nested,
    env: { GEMINI_CLI_HOME: configuredHome },
    managerRecords: [],
  };
  const global = await discoverSkills({
    input: "configured-gemini-review",
    ...options,
  });
  const workspace = await discoverSkills({
    input: "workspace-gemini-review",
    ...options,
  });

  assert.equal(global.groups[0].copies[0].path, globalSkill);
  assert.equal(global.groups[0].copies[0].scope, "global");
  assert.equal(global.groups[0].copies[0].plugin.host, "gemini-cli");
  assert.deepEqual(global.groups[0].provenance, [
    "repository:https://github.com/example/global-extension",
  ]);
  assert.equal(workspace.groups[0].copies[0].path, workspaceSkill);
  assert.equal(workspace.groups[0].copies[0].scope, "workspace");
  assert.equal(workspace.groups[0].copies[0].plugin.name, "workspace-extension");
});

test("Gemini extension diagnostics isolate malformed metadata and escaping skill roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-gemini-diagnostics-"));
  const home = path.join(root, "home");
  const extensions = path.join(home, ".gemini", "extensions");
  const validExtension = path.join(extensions, "valid-extension");
  await writeSkill(path.join(validExtension, "skills"), "valid-gemini-review");
  await writeFile(
    path.join(validExtension, "gemini-extension.json"),
    JSON.stringify({ name: "valid-extension", version: "1.0.0" }),
  );

  const malformedExtension = path.join(extensions, "malformed-extension");
  await writeSkill(path.join(malformedExtension, "skills"), "malformed-gemini-review");
  const malformedManifest = path.join(malformedExtension, "gemini-extension.json");
  await writeFile(malformedManifest, "{broken\n");

  const escapingExtension = path.join(extensions, "escaping-extension");
  await writeSkill(path.join(escapingExtension, "skills"), "escaping-gemini-review");
  const escapingManifest = path.join(escapingExtension, "gemini-extension.json");
  await writeFile(
    escapingManifest,
    JSON.stringify({
      name: "escaping-extension",
      version: "1.0.0",
      skills: ["skills", "../outside"],
    }),
  );

  const result = await discoverSkills({
    input: "valid-gemini-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups[0].name, "valid-gemini-review");
  assert.equal(result.groups.some(({ name }) => name === "malformed-gemini-review"), false);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "MALFORMED_PLUGIN_METADATA" && diagnosticPath === malformedManifest,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE" && diagnosticPath === path.join(escapingExtension, "../outside"),
  ));
});

test("Gemini validates metadata containment, required fields, and install provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-gemini-metadata-"));
  const home = path.join(root, "home");
  const extensions = path.join(home, ".gemini", "extensions");

  const installedExtension = path.join(extensions, "installed-extension");
  await writeSkill(path.join(installedExtension, "skills"), "installed-gemini-review");
  await writeFile(
    path.join(installedExtension, "gemini-extension.json"),
    JSON.stringify({ name: "installed-extension", version: "1.0.0" }),
  );
  await writeFile(
    path.join(installedExtension, ".gemini-extension-install.json"),
    JSON.stringify({
      source: "https://github.com/example/installed-extension",
      type: "git",
    }),
  );

  const outsideManifest = path.join(root, "outside-gemini-extension.json");
  await writeFile(
    outsideManifest,
    JSON.stringify({ name: "escaped-extension", version: "1.0.0" }),
  );
  const escapedExtension = path.join(extensions, "escaped-extension");
  await writeSkill(path.join(escapedExtension, "skills"), "escaped-gemini-review");
  const escapedManifest = path.join(escapedExtension, "gemini-extension.json");
  await symlink(outsideManifest, escapedManifest, "file");

  const invalidExtension = path.join(extensions, "invalid-extension");
  await writeSkill(path.join(invalidExtension, "skills"), "invalid-gemini-review");
  const invalidManifest = path.join(invalidExtension, "gemini-extension.json");
  await writeFile(
    invalidManifest,
    JSON.stringify({ name: "different-extension", version: "1.0.0", skills: 42 }),
  );

  const invalidInstallExtension = path.join(extensions, "invalid-install-extension");
  await writeSkill(path.join(invalidInstallExtension, "skills"), "invalid-install-gemini-review");
  await writeFile(
    path.join(invalidInstallExtension, "gemini-extension.json"),
    JSON.stringify({ name: "invalid-install-extension", version: "1.0.0" }),
  );
  const invalidInstallMetadata = path.join(
    invalidInstallExtension,
    ".gemini-extension-install.json",
  );
  await writeFile(
    invalidInstallMetadata,
    JSON.stringify({
      source: { url: "https://github.com/attacker/wrong" },
      type: "git",
    }),
  );

  const invalidDeclaredExtension = path.join(extensions, "invalid-declared-extension");
  await writeSkill(path.join(invalidDeclaredExtension, "skills"), "invalid-declared-gemini-review");
  const invalidDeclaredManifest = path.join(
    invalidDeclaredExtension,
    "gemini-extension.json",
  );
  await writeFile(
    invalidDeclaredManifest,
    JSON.stringify({ name: "invalid-declared-extension", version: "1.0.0", skills: 42 }),
  );

  const linkedOrigin = path.join(root, "linked-origin");
  await writeSkill(linkedOrigin, "unwanted-linked-origin-review");
  const linkedExtension = path.join(extensions, "linked-extension");
  await writeSkill(path.join(linkedExtension, "skills"), "linked-gemini-review");
  await writeFile(
    path.join(linkedExtension, "gemini-extension.json"),
    JSON.stringify({ name: "linked-extension", version: "1.0.0" }),
  );
  await writeFile(
    path.join(linkedExtension, ".gemini-extension-install.json"),
    JSON.stringify({ source: linkedOrigin, type: "link" }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  const installedGroup = result.groups.find(({ name }) => name === "installed-gemini-review");
  assert.deepEqual(installedGroup.provenance, [
    "repository:https://github.com/example/installed-extension",
  ]);
  assert.equal(result.groups.some(({ name }) => name === "invalid-gemini-review"), false);
  const invalidInstallGroup = result.groups.find(
    ({ name }) => name === "invalid-install-gemini-review",
  );
  assert.deepEqual(invalidInstallGroup.provenance, [
    "local:plugin:gemini-cli:local:invalid-install-extension",
  ]);
  assert.equal(invalidInstallGroup.copies[0].evidence[0].installation, undefined);
  assert.equal(result.groups.some(({ name }) => name === "invalid-declared-gemini-review"), true);
  assert.equal(result.groups.some(({ name }) => name === "unwanted-linked-origin-review"), false);
  const linkedGroup = result.groups.find(({ name }) => name === "linked-gemini-review");
  assert.deepEqual(linkedGroup.copies[0].evidence[0].installation, {
    source: linkedOrigin,
    type: "link",
  });
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_METADATA_ESCAPE" && diagnosticPath === escapedManifest,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "INVALID_PLUGIN_METADATA" && diagnosticPath === invalidManifest,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath, message }) =>
      code === "INVALID_PLUGIN_METADATA"
      && diagnosticPath === invalidManifest
      && message.includes("must match its extension directory"),
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_SKILL_DIRECTORY_INVALID" && diagnosticPath === invalidManifest,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "INVALID_PLUGIN_INSTALL_METADATA" && diagnosticPath === invalidInstallMetadata,
  ));
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_SKILL_DIRECTORY_INVALID" && diagnosticPath === invalidDeclaredManifest,
  ));
});

test("Codex personal marketplaces discover .codex-plugin custom skill directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-personal-marketplace-"));
  const home = path.join(root, "home");
  const plugin = path.join(home, "plugins", "personal-plugin");
  await writeSkill(plugin, "custom", "personal-review");
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(plugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "personal-plugin",
      version: "1.0.0",
      repository: "https://github.com/example/personal-plugin",
      skills: "./custom",
    }),
  );
  await mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "personal",
      plugins: [{
        name: "personal-plugin",
        source: { source: "local", path: "./plugins/personal-plugin" },
      }],
    }),
  );

  const result = await discoverSkills({
    input: "personal-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: path.join(home, ".codex") },
    managerRecords: [],
  });

  const copy = result.groups[0].copies[0];
  assert.equal(copy.path, path.join(plugin, "custom"));
  assert.deepEqual(copy.plugin, {
    host: "codex",
    marketplace: "personal",
    name: "personal-plugin",
    version: "1.0.0",
  });
  assert.match(copy.pluginMetadata.manifestPath, /\.codex-plugin[\\/]plugin\.json$/);
  assert.deepEqual(result.groups[0].provenance, [
    "repository:https://github.com/example/personal-plugin",
  ]);
});

test("Codex config.toml local marketplaces discover bounded external roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-config-marketplace-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const marketplaceRoot = path.join(root, "configured-marketplace");
  const plugin = path.join(marketplaceRoot, "plugins", "configured-plugin");
  await writeSkill(plugin, "custom", "configured-review");
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(plugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "configured-plugin",
      skills: "./custom",
      repository: "https://github.com/example/configured-plugin",
    }),
  );
  await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "configured-marketplace",
      plugins: [{
        name: "configured-plugin",
        source: { source: "local", path: "./plugins/configured-plugin" },
      }],
    }),
  );
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    `["marketplaces" . configured-marketplace] # development checkout\n"source_type" = "local"\n'source' = "${marketplaceRoot}"\n\n[marketplaces."broken-marketplace"]\nsource_type = local\nsource = "${marketplaceRoot}"\n`,
  );

  const result = await discoverSkills({
    input: "configured-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });

  const copy = result.groups[0].copies[0];
  assert.equal(copy.path, path.join(plugin, "custom"));
  assert.deepEqual(copy.plugin, {
    host: "codex",
    marketplace: "configured-marketplace",
    name: "configured-plugin",
  });
  assert.deepEqual(result.groups[0].provenance, [
    "repository:https://github.com/example/configured-plugin",
  ]);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "MALFORMED_PLUGIN_CONFIGURATION"
      && diagnosticPath === path.join(codexHome, "config.toml"),
  ));
});

test("Codex config.toml accepts dotted marketplace assignments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-dotted-config-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const marketplaceRoot = path.join(root, "dotted-marketplace");
  const plugin = path.join(marketplaceRoot, "plugins", "dotted-plugin");
  await writeSkill(plugin, "skills", "dotted-config-review");
  await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "dotted-marketplace",
      plugins: [{
        name: "dotted-plugin",
        source: { source: "local", path: "./plugins/dotted-plugin" },
      }],
    }),
  );
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    `marketplaces.dotted-marketplace.source_type = "local"\nmarketplaces.dotted-marketplace.source = "${marketplaceRoot}"\n`,
  );

  const result = await discoverSkills({
    input: "dotted-config-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies[0].path, path.join(plugin, "skills"));
  assert.equal(result.groups[0].copies[0].plugin.marketplace, "dotted-marketplace");
  assert.equal(
    result.pluginDiagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_CONFIGURATION"),
    false,
  );
});

test("Codex config.toml decodes uppercase Unicode escapes in basic strings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-unicode-config-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const marketplaceRoot = path.join(root, "unicode-marketplace");
  const plugin = path.join(marketplaceRoot, "plugins", "unicode-plugin");
  await writeSkill(plugin, "skills", "unicode-config-review");
  await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "unicode-marketplace",
      plugins: [{
        name: "unicode-plugin",
        source: { source: "local", path: "./plugins/unicode-plugin" },
      }],
    }),
  );
  await mkdir(codexHome, { recursive: true });
  const escapedMarketplaceRoot = `\\U0000002F${marketplaceRoot.slice(1)}`;
  await writeFile(
    path.join(codexHome, "config.toml"),
    `["\\U0000006Darketplaces"."\\U00000075nicode-marketplace"]\n"source_\\U00000074ype" = "local"\n"\\U00000073ource" = "${escapedMarketplaceRoot}"\n`,
  );

  const result = await discoverSkills({
    input: "unicode-config-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies[0].path, path.join(plugin, "skills"));
  assert.equal(result.groups[0].copies[0].plugin.marketplace, "unicode-marketplace");
  assert.equal(
    result.pluginDiagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_CONFIGURATION"),
    false,
  );
});

test("Codex config.toml accepts multiline marketplace source strings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-multiline-config-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const marketplaceRoots = new Map();
  for (const kind of ["basic", "literal"]) {
    const marketplaceRoot = path.join(root, `${kind}-marketplace`);
    const plugin = path.join(marketplaceRoot, "plugins", `${kind}-plugin`);
    await writeSkill(plugin, "skills", `${kind}-multiline-review`);
    await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
    await writeFile(
      path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: `${kind}-marketplace`,
        plugins: [{
          name: `${kind}-plugin`,
          source: { source: "local", path: `./plugins/${kind}-plugin` },
        }],
      }),
    );
    marketplaceRoots.set(kind, marketplaceRoot);
  }
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      "[marketplaces.basic]",
      'source_type = "local"',
      'source = """',
      marketplaceRoots.get("basic"),
      '"""',
      "",
      "[marketplaces.literal]",
      "source_type = 'local'",
      "source = '''",
      marketplaceRoots.get("literal"),
      "'''",
      "",
    ].join("\n"),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });
  const byName = new Map(result.groups.map((group) => [group.name, group]));

  for (const kind of marketplaceRoots.keys()) {
    const group = byName.get(`${kind}-multiline-review`);
    assert.ok(
      group,
      `missing ${kind} multiline marketplace; discovered: ${[...byName.keys()].join(", ")}`,
    );
    assert.equal(group.copies[0].plugin.marketplace, `${kind}-marketplace`);
  }
  assert.equal(
    result.pluginDiagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_CONFIGURATION"),
    false,
  );
});

test("Codex cache versions and synced or bundled marketplace copies remain auditable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-cache-layouts-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const directPlugin = path.join(codexHome, "plugins", "direct-plugin");
  await writeSkill(directPlugin, "skills", "direct-review");
  const cachePlugin = path.join(codexHome, "plugins", "cache", "official", "versioned");
  for (const version of ["1.0.0", "2.0.0"]) {
    const install = path.join(cachePlugin, version);
    await writeSkill(install, "skills", "versioned-review");
    await mkdir(path.join(install, ".codex-plugin"), { recursive: true });
    await writeFile(
      path.join(install, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "versioned",
        version,
        repository: "https://github.com/example/versioned",
      }),
    );
  }
  await writeFile(
    path.join(cachePlugin, ".codex-remote-plugin-install.json"),
    JSON.stringify({ schema_version: 1, remote_plugin_id: "fixture" }),
  );

  const syncedRoot = path.join(codexHome, ".tmp", "plugins");
  const syncedPlugin = path.join(syncedRoot, "plugins", "synced-plugin");
  await writeSkill(syncedPlugin, "custom", "synced-review");
  await mkdir(path.join(syncedPlugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(syncedPlugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "synced-plugin",
      skills: "./custom",
      repository: "https://github.com/example/synced-plugin",
    }),
  );
  await mkdir(path.join(syncedRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(syncedRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "synced-marketplace",
      plugins: [
        {
          name: "synced-plugin",
          source: { source: "local", path: "./plugins/synced-plugin" },
        },
        {
          name: "escaped-plugin",
          source: { source: "local", path: "../../../../outside" },
        },
      ],
    }),
  );

  const bundledRoot = path.join(codexHome, ".tmp", "bundled-marketplaces", "official-bundled");
  const bundledPlugin = path.join(bundledRoot, "plugins", "bundled-plugin");
  await writeSkill(bundledPlugin, "custom", "bundled-review");
  await mkdir(path.join(bundledPlugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(bundledPlugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "bundled-plugin",
      skills: "./custom",
      repository: "https://github.com/example/bundled-plugin",
    }),
  );
  await mkdir(path.join(bundledRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(bundledRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "bundled-marketplace",
      plugins: [{
        name: "bundled-plugin",
        source: { source: "local", path: "./plugins/bundled-plugin" },
      }],
    }),
  );

  const options = {
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  };
  const direct = await discoverSkills({ input: "direct-review", ...options });
  assert.equal(direct.groups[0].copies[0].plugin.host, "codex");
  assert.equal(direct.groups[0].copies[0].plugin.name, "direct-plugin");

  const cached = await discoverSkills({ input: "versioned-review", ...options });
  assert.equal(cached.groups[0].copies.length, 2);
  assert.deepEqual(
    cached.groups[0].copies.map(({ plugin }) => plugin.version),
    ["1.0.0", "2.0.0"],
  );
  assert.equal(
    cached.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_NOT_DIRECTORY"),
    false,
  );

  const synced = await discoverSkills({ input: "synced-review", ...options });
  assert.equal(synced.groups[0].copies[0].plugin.marketplace, "synced-marketplace");
  assert.deepEqual(synced.groups[0].provenance, [
    "repository:https://github.com/example/synced-plugin",
  ]);
  assert.ok(synced.pluginDiagnostics.some(({ code }) => code === "PLUGIN_ROOT_ESCAPE"));

  const bundled = await discoverSkills({ input: "bundled-review", ...options });
  assert.equal(bundled.groups[0].copies[0].plugin.marketplace, "bundled-marketplace");
  assert.equal(bundled.groups[0].copies[0].active, false);
  assert.deepEqual(activeSkillInventory(bundled), []);
  assert.deepEqual(bundled.groups[0].provenance, [
    "repository:https://github.com/example/bundled-plugin",
  ]);
});

test("malformed higher-priority Codex marketplace metadata stops generic fallbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-codex-malformed-marketplace-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const install = path.join(codexHome, "plugins", "cache", "official", "valid", "1.0.0");
  await writeSkill(install, "skills", "valid-codex-review");
  await mkdir(path.join(install, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(install, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "valid", version: "1.0.0" }),
  );
  await mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
  const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");
  await writeFile(marketplacePath, "{broken\n");
  const invalidEntriesPath = path.join(home, ".agents", "plugins", "plugins.json");
  await writeFile(invalidEntriesPath, JSON.stringify({ plugins: "invalid" }));
  const missingEntriesPath = path.join(home, ".agents", "plugins", "manifest.json");
  await writeFile(missingEntriesPath, JSON.stringify({ name: "missing-entries" }));

  const result = await discoverSkills({
    input: "valid-codex-review",
    home,
    cwd: path.join(root, "workspace"),
    env: { CODEX_HOME: codexHome },
    managerRecords: [],
  });

  assert.equal(result.groups[0].name, "valid-codex-review");
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "MALFORMED_PLUGIN_METADATA" && diagnosticPath === marketplacePath,
  ));
  assert.equal(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_INVALID_ENTRIES" && diagnosticPath === invalidEntriesPath,
  ), false);
  assert.equal(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_MARKETPLACE_MISSING_ENTRIES" && diagnosticPath === missingEntriesPath,
  ), false);
});

test("plugin host specifications extend discovery without changing candidate policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-host-seam-"));
  const home = path.join(root, "home");
  const skill = await writeSkill(path.join(root, "future-plugin", "skills"), "future-review");
  const identity = "local:plugin:future-host:local:future";
  const plugin = {
    host: "future-host",
    marketplace: "local",
    name: "future",
  };

  const result = await discoverSkills({
    input: "future-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
    pluginOptions: {
      hostSpecifications: [{
        host: "future-host",
        discover: async (context) => {
          context.roots.push({
            path: path.dirname(skill),
            owner: "plugin:future-host",
            owners: ["plugin:future-host"],
            scope: "global",
            origin: "plugin",
            host: "future-host",
            plugin,
            pluginIdentity: identity,
            pluginEvidence: [{
              kind: "plugin",
              ...plugin,
              identity,
              provenance: { kind: "plugin", ...plugin },
            }],
          });
        },
      }],
    },
  });

  assert.equal(result.groups[0].copies[0].path, skill);
  assert.equal(result.groups[0].copies[0].plugin.host, "future-host");
  assert.deepEqual(result.groups[0].provenance, [identity]);
});

test("plugin cache versions preserve every copy without making version part of identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-versions-"));
  const home = path.join(root, "home");
  const cacheRoot = path.join(home, ".claude", "plugins", "cache", "official", "reviewer");
  await writeSkill(path.join(cacheRoot, "1", "skills"), "review");
  await writeSkill(path.join(cacheRoot, "2", "skills"), "review");

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 2);
  assert.deepEqual(result.groups[0].provenance, [
    "local:plugin:claude-code:official:reviewer",
  ]);
  assert.equal(
    result.groups[0].evidence.every(({ repository }) => repository === undefined),
    true,
  );
  assert.deepEqual(result.groups[0].copies.map(({ active }) => active), [false, false]);
  assert.deepEqual(activeSkillInventory(result), []);
});

test("plugin identities escape delimiter-bearing names without collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-identities-"));
  const home = path.join(root, "home");
  const cacheRoot = path.join(home, ".claude", "plugins", "cache", "official");
  await writeSkill(path.join(cacheRoot, "a:b", "1", "skills"), "review");
  await writeSkill(path.join(cacheRoot, "a%3Ab", "1", "skills"), "review");

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].provenance, [
    "local:plugin:claude-code:official:a%253Ab",
    "local:plugin:claude-code:official:a%3Ab",
  ]);
  assert.equal(result.groups[0].conflict, true);
});

test("Claude marketplace discovery selects its host manifest and repository provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-marketplace-"));
  const home = path.join(root, "home");
  const marketplace = path.join(home, ".claude", "plugins", "marketplaces", "team");
  const escapedPlugin = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    "other",
    "plugins",
    "escaped",
  );
  const foreignPlugin = path.join(marketplace, "plugins", "cursor-only");
  await writeSkill(path.join(marketplace, "plugins", "reviewer", "skills"), "market-review");
  await writeSkill(path.join(foreignPlugin, "skills"), "cursor-only-market-review");
  await writeSkill(path.join(escapedPlugin, "skills"), "escaped-market-review");
  await mkdir(path.join(marketplace, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "team",
      plugins: [
        {
          name: "reviewer",
          source: "./plugins/reviewer",
          repository: "https://github.com/example/team-skills",
        },
        {
          name: "escaped",
          source: "../other/plugins/escaped",
          repository: "https://github.com/example/team-skills",
        },
      ],
    }),
  );
  await mkdir(path.join(marketplace, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(marketplace, ".cursor-plugin", "marketplace.json"),
    JSON.stringify({
      name: "cursor-team",
      owner: { name: "fixture" },
      plugins: [{ name: "cursor-only", source: "./plugins/cursor-only" }],
    }),
  );

  const result = await discoverSkills({
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, "market-review");
  assert.equal(result.groups.some(({ name }) => name === "cursor-only-market-review"), false);
  assert.deepEqual(result.groups[0].provenance, [
    "repository:https://github.com/example/team-skills",
  ]);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE" && diagnosticPath === escapedPlugin,
  ));
  assert.equal(
    result.pluginDiagnostics.some(({ code }) => code === "INVALID_PLUGIN_REPOSITORY"),
    false,
  );
});

test("Claude marketplace catalogs stay audit-only beside an installed cache copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-claude-catalog-active-"));
  const home = path.join(root, "home");
  const pluginsRoot = path.join(home, ".claude", "plugins");
  const marketplace = path.join(pluginsRoot, "marketplaces", "official");
  const catalogPlugin = path.join(marketplace, "plugins", "reviewer");
  const cachePlugin = path.join(pluginsRoot, "cache", "official", "reviewer", "1.0.0");
  const catalogSkill = await writeSkill(path.join(catalogPlugin, "skills"), "review");
  const cacheSkill = await writeSkill(path.join(cachePlugin, "skills"), "review");
  await mkdir(path.join(marketplace, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "official",
      plugins: [{ name: "reviewer", source: "./plugins/reviewer" }],
    }),
  );
  await writeFile(
    path.join(pluginsRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "reviewer@official": [{
          installPath: cachePlugin,
          version: "1.0.0",
          scope: "user",
        }],
      },
    }),
  );

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 2);
  assert.equal(
    result.groups[0].copies.find(({ path: skillPath }) => skillPath === catalogSkill).active,
    false,
  );
  assert.deepEqual(activeSkillInventory(result), [
    { name: "review", path: cacheSkill, realPath: await realpath(cacheSkill) },
  ]);
});

test("host roots include bounded Git ancestors as workspace roots", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "host-roots-"));
  const repository = path.join(base, "repository");
  const nested = path.join(repository, "packages", "app");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  const roots = hostSkillRoots({ home: base, cwd: nested, env: {} });
  assert.ok(
    roots.some(
      (item) =>
        item.path === path.join(repository, ".codex", "skills") &&
        item.scope === "workspace" &&
        item.origin === "ancestor",
    ),
  );
  assert.ok(
    roots.some(
      (item) =>
        item.path === path.join(repository, ".agents", "skills") &&
        item.origin === "ancestor",
    ),
  );
  assert.equal(roots.some(({ path: rootPath }) => rootPath === base), false);
});

test("configured host roots load bounded global and workspace Claude settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-settings-"));
  const home = path.join(root, "home");
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "packages", "app");
  const directSkills = path.join(root, "direct", "skills");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(repository, ".claude"), { recursive: true });
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ additionalDirectories: ["~/shared"] }),
  );
  await writeFile(
    path.join(repository, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { additionalDirectories: ["../team", directSkills] },
    }),
  );

  const configured = await configuredHostSkillRoots({ home, cwd: nested, env: {} });
  const paths = configured.roots.map(({ path: rootPath }) => rootPath);
  assert.ok(paths.includes(path.join(home, "shared", ".claude", "skills")));
  assert.ok(paths.includes(path.join(root, "team", ".claude", "skills")));
  assert.ok(paths.includes(directSkills));
  assert.equal(configured.settingsEvidence.length, 3);
  assert.deepEqual(configured.diagnostics, []);
  assert.equal(paths.some((rootPath) => rootPath === root), false);
});

test("discovery groups equivalent copies and exposes every path and owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-"));
  const codexRoot = path.join(root, ".codex", "skills");
  const copilotRoot = path.join(root, ".copilot", "skills");
  await writeSkill(codexRoot, "review");
  await writeSkill(copilotRoot, "review");
  await writeSkill(path.join(root, "unbounded"), "secret");

  const result = await discoverSkills({
    input: "review",
    roots: [
      { path: codexRoot, owner: "codex", scope: "global" },
      { path: copilotRoot, owner: "copilot", scope: "global" },
    ],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 2);
  assert.deepEqual(
    result.groups[0].copies.map(({ owner }) => owner).sort(),
    ["codex", "copilot"],
  );
  assert.equal(result.groups.some(({ name }) => name === "secret"), false);
  assert.deepEqual(result.choices.at(-1), { kind: "custom-path" });
});

test("discovery preserves plugin metadata when a standard root aliases the same physical source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-alias-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const pluginInstall = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "reviewer",
    "2.0.0",
  );
  const pluginSkills = path.join(pluginInstall, "skills");
  await writeSkill(pluginSkills, "review");
  const escapedSkill = await writeSkill(
    path.join(root, "outside"),
    "escaped",
    "escaped-review",
  );
  await symlink(escapedSkill, path.join(pluginSkills, "escaped"), "dir");
  await mkdir(path.join(pluginInstall, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginInstall, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "reviewer",
      repository: "https://github.com/example/reviewer",
    }),
  );
  await mkdir(path.join(workspace, ".agents"), { recursive: true });
  await symlink(pluginSkills, path.join(workspace, ".agents", "skills"), "dir");

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: workspace,
    env: {},
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 1);
  const copy = result.groups[0].copies[0];
  assert.equal(copy.plugin.host, "claude-code");
  assert.equal(copy.plugin.version, "2.0.0");
  assert.equal(copy.pluginIdentity, "local:plugin:claude-code:official:reviewer");
  assert.deepEqual(copy.provenance, [
    "repository:https://github.com/example/reviewer",
  ]);
  assert.ok(copy.owners.includes("plugin:claude-code"));
  assert.equal(result.groups.some(({ name }) => name === "escaped-review"), false);
  assert.ok(result.pluginDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "PLUGIN_ROOT_ESCAPE"
      && diagnosticPath === path.join(workspace, ".agents", "skills", "escaped"),
  ));
});

test("discovery preserves plugin root-skill scan and fingerprint policy through standard aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-policy-alias-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const cursorPlugins = path.join(home, ".cursor", "plugins", "local");

  const rootPlugin = path.join(cursorPlugins, "root-plugin");
  await mkdir(rootPlugin, { recursive: true });
  const rootWorkflow = "---\nname: root-review\ndescription: Fixture\n---\nUse the root workflow.\n";
  await writeFile(path.join(rootPlugin, "SKILL.md"), rootWorkflow);
  await writeSkill(rootPlugin, "extra", "root-extra-review");
  await writeFile(
    path.join(rootPlugin, "plugin.json"),
    JSON.stringify({ name: "root-plugin" }),
  );

  const folderPlugin = path.join(cursorPlugins, "folder-plugin");
  const folderSkills = path.join(folderPlugin, "skills");
  await mkdir(folderSkills, { recursive: true });
  await writeFile(
    path.join(folderSkills, "SKILL.md"),
    "---\nname: folder-root-review\ndescription: Fixture\n---\nDo not expose this root.\n",
  );
  await writeSkill(folderSkills, "child", "folder-child-review");
  await writeFile(
    path.join(folderPlugin, "plugin.json"),
    JSON.stringify({ name: "folder-plugin" }),
  );

  await mkdir(path.join(workspace, ".agents"), { recursive: true });
  await mkdir(path.join(workspace, ".cursor"), { recursive: true });
  await symlink(rootPlugin, path.join(workspace, ".agents", "skills"), "dir");
  await symlink(folderSkills, path.join(workspace, ".cursor", "skills"), "dir");

  const result = await discoverSkills({
    home,
    cwd: workspace,
    env: {},
    managerRecords: [],
  });
  const groups = new Map(result.groups.map((group) => [group.name, group]));

  assert.equal(groups.get("root-review").fingerprint, await fingerprintPath(rootPlugin));
  assert.equal(groups.has("root-extra-review"), false);
  assert.equal(groups.has("folder-root-review"), false);
  assert.equal(groups.has("folder-child-review"), true);

  const rootRecord = result.searchedRoots.find(
    ({ path: rootPath }) => rootPath === path.join(workspace, ".agents", "skills"),
  );
  const folderRecord = result.searchedRoots.find(
    ({ path: rootPath }) => rootPath === path.join(workspace, ".cursor", "skills"),
  );
  assert.ok(rootRecord);
  assert.ok(folderRecord);
  assert.equal(rootRecord.path, path.join(workspace, ".agents", "skills"));
  assert.equal(rootRecord.physicalPath, await realpath(rootPlugin));
  assert.equal(rootRecord.origin, "plugin");
  assert.equal(rootRecord.singleSkill, true);
  assert.equal(rootRecord.pluginRoot, rootPlugin);
  assert.equal(folderRecord.path, path.join(workspace, ".cursor", "skills"));
  assert.equal(folderRecord.physicalPath, await realpath(folderSkills));
  assert.equal(folderRecord.origin, "plugin");
  assert.equal(folderRecord.includeRootSkill, false);
  assert.equal(folderRecord.pluginRoot, folderPlugin);
});

test("Cursor root-skill fallback fingerprints its full source and rejects symlinked entrypoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-cursor-root-fingerprint-"));
  const home = path.join(root, "home");
  const localRoot = path.join(home, ".cursor", "plugins", "local");
  const workflow = "---\nname: root-review\ndescription: Fixture\n---\nUse the root workflow.\n";

  const first = path.join(localRoot, "first");
  await mkdir(path.join(first, "references"), { recursive: true });
  await writeFile(path.join(first, "SKILL.md"), workflow);
  await writeFile(path.join(first, "references", "guide.md"), "first guidance\n");
  await writeFile(path.join(first, "plugin.json"), JSON.stringify({ name: "first" }));

  const second = path.join(localRoot, "second");
  await mkdir(path.join(second, "references"), { recursive: true });
  await writeFile(path.join(second, "SKILL.md"), workflow);
  await writeFile(path.join(second, "references", "guide.md"), "second guidance\n");
  await writeFile(path.join(second, "plugin.json"), JSON.stringify({ name: "second" }));

  const symlinked = path.join(localRoot, "symlinked");
  await mkdir(symlinked, { recursive: true });
  await writeFile(path.join(symlinked, "workflow.md"), workflow);
  await symlink("workflow.md", path.join(symlinked, "SKILL.md"));
  await writeFile(
    path.join(symlinked, "plugin.json"),
    JSON.stringify({ name: "symlinked" }),
  );

  const result = await discoverSkills({
    input: "root-review",
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.deepEqual(
    result.groups.map(({ fingerprint }) => fingerprint).sort(),
    [await fingerprintPath(first), await fingerprintPath(second)].sort(),
  );
  assert.ok(result.candidateDiagnostics.some(
    ({ code, path: diagnosticPath }) =>
      code === "FINGERPRINT_SYMLINK" && diagnosticPath === symlinked,
  ));
});

test("discovery groups standard and plugin copies while keeping conflicting plugin identities selectable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-candidates-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const standardSkill = await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "review",
    "review",
    "Use the shared workflow.\n",
  );
  const firstSkill = await writeSkill(
    path.join(root, "plugin-one", "skills"),
    "review",
    "review",
    "Use the shared workflow.\n",
  );
  const secondSkill = await writeSkill(
    path.join(root, "plugin-two", "skills"),
    "review",
    "review",
    "Use the shared workflow.\n",
  );
  const firstIdentity = "local:plugin:test:one";
  const secondIdentity = "local:plugin:test:two";
  const pluginRoot = (skill, name, identity) => ({
    path: path.dirname(skill),
    owner: "plugin:test",
    owners: ["plugin:test"],
    scope: "global",
    origin: "plugin",
    plugin: { host: "test", marketplace: "fixture", name },
    pluginIdentity: identity,
    pluginEvidence: [{
      kind: "plugin",
      host: "test",
      plugin: name,
      marketplace: "fixture",
      identity,
      provenance: { kind: "plugin", host: "test", plugin: name },
    }],
  });

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: workspace,
    env: {},
    managerRecords: [],
    pluginDiscovery: async () => ({
      roots: [
        pluginRoot(firstSkill, "one", firstIdentity),
        pluginRoot(secondSkill, "two", secondIdentity),
      ],
      diagnostics: [],
    }),
  });

  assert.equal(result.groups.length, 1);
  const group = result.groups[0];
  assert.equal(group.copies.length, 3);
  assert.deepEqual(
    group.copies.map(({ path: copyPath }) => copyPath).sort(),
    [firstSkill, secondSkill, standardSkill].sort(),
  );
  assert.deepEqual(group.provenance, [firstIdentity, secondIdentity]);
  assert.equal(group.conflict, true);

  const selected = confirmDiscoverySelection({
    discovery: result,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: secondSkill,
      owner: "plugin:test",
    },
    interactive: true,
    confirmedProvenance: secondIdentity,
  });
  assert.equal(selected.copy.path, secondSkill);
  assert.equal(selected.provenance, secondIdentity);
});

test("discovery isolates an invalid sibling candidate and reports its diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-invalid-sibling-"));
  await writeSkill(root, "review");
  const invalid = await writeSkill(root, "invalid");
  await symlink(path.join(invalid, "SKILL.md"), path.join(invalid, "LINK.md"));

  const result = await discoverSkills({
    input: "review",
    roots: [{ path: root, owner: "codex", scope: "global" }],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, "review");
  assert.deepEqual(result.candidateDiagnostics, [
    {
      path: invalid,
      code: "FINGERPRINT_SYMLINK",
      message: "directory fingerprint contains a symbolic link: LINK.md",
    },
  ]);
});

test("discovery isolates malformed embedded metadata in a sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-malformed-sibling-"));
  await writeSkill(root, "review");
  const malformed = await writeSkill(root, "malformed");
  await writeFile(path.join(malformed, ".skill-source.json"), "{not-json\n");

  const result = await discoverSkills({
    input: "review",
    roots: [{ path: root, owner: "codex", scope: "global" }],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, "review");
  assert.equal(result.candidateDiagnostics.length, 1);
  assert.equal(result.candidateDiagnostics[0].path, malformed);
  assert.equal(
    result.candidateDiagnostics[0].code,
    "MALFORMED_SOURCE_METADATA",
  );
  await assert.rejects(
    discoverSkills({
      input: malformed,
      roots: [{ path: root, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "MALFORMED_SOURCE_METADATA",
  );
});

test("an explicit invalid alias preserves its specific candidate error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-invalid-alias-"));
  const invalid = await writeSkill(root, "invalid");
  const alias = path.join(root, "installed-invalid");
  await symlink(path.join(invalid, "SKILL.md"), path.join(invalid, "LINK.md"));
  await symlink(invalid, alias);

  await assert.rejects(
    discoverSkills({
      input: alias,
      roots: [{ path: invalid, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "FINGERPRINT_SYMLINK",
  );
});

test("discovery scans an aliased physical root once and retains associated owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "physical-root-"));
  const physical = path.join(root, "physical");
  const firstAlias = path.join(root, "first-alias");
  const secondAlias = path.join(root, "second-alias");
  await writeSkill(physical, "review");
  await symlink(physical, firstAlias, "dir");
  await symlink(physical, secondAlias, "dir");

  const result = await discoverSkills({
    input: "review",
    roots: [
      { path: firstAlias, owner: "codex", scope: "global" },
      { path: secondAlias, owner: "cursor", scope: "global" },
    ],
    managerRecords: [],
  });

  assert.equal(result.searchedRoots.length, 1);
  assert.equal(result.groups[0].copies.length, 1);
  assert.deepEqual(result.groups[0].copies[0].owners, ["codex", "cursor"]);
  assert.deepEqual(result.searchedRoots[0].aliases.sort(), [firstAlias, secondAlias]);
});

test("discovery orders explicit, Git, manager, and embedded evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-"));
  const repository = path.join(root, "repo");
  const skillsRoot = path.join(repository, "skills");
  const skill = await writeSkill(skillsRoot, "review");
  await writeFile(
    path.join(skill, ".skill-source.json"),
    JSON.stringify({
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review",
    }),
  );
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repository, "remote", "add", "origin", "git@github.com:example/skills.git"]).status,
    0,
  );

  const result = await discoverSkills({
    input: skill,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: {
          kind: "repository",
          repository: "https://github.com/example/skills",
          upstreamPath: "skills/review",
        },
      },
    ],
  });
  assert.deepEqual(
    result.groups[0].evidence.map(({ kind }) => kind),
    ["explicit", "git", "manager", "embedded"],
  );
  assert.equal(result.groups[0].conflict, false);
});

test("discovery keeps Git evidence ahead of plugin evidence without hiding a conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-plugin-evidence-"));
  const home = path.join(root, "repository");
  const install = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "reviewer",
    "1",
  );
  await writeSkill(path.join(install, "skills"), "review");
  await mkdir(path.join(install, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "reviewer",
      repository: "https://github.com/example/plugin-reviewer",
    }),
  );
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("git", ["init", "-q", home]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", home, "remote", "add", "origin", "https://github.com/example/git-reviewer"]).status,
    0,
  );

  const result = await discoverSkills({
    input: "review",
    home,
    cwd: path.join(home, "workspace"),
    env: {},
    managerRecords: [],
  });

  assert.deepEqual(result.groups[0].evidence.map(({ kind }) => kind), [
    "git",
    "plugin",
  ]);
  assert.equal(result.groups[0].provenance.length, 2);
  assert.equal(result.groups[0].conflict, true);
  assert.ok(result.groups[0].provenance.includes(
    "repository:https://github.com/example/plugin-reviewer",
  ));
  assert.ok(result.groups[0].provenance.some((value) =>
    value.startsWith("repository:https://github.com/example/git-reviewer#"),
  ));
});

test("discovery surfaces provenance conflicts instead of merging silently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conflict-"));
  const skillsRoot = path.join(root, "skills");
  const skill = await writeSkill(skillsRoot, "review");
  const result = await discoverSkills({
    input: "review",
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: { kind: "repository", repository: "https://github.com/a/one" },
      },
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: { kind: "repository", repository: "https://github.com/b/two" },
      },
    ],
  });
  assert.equal(result.groups[0].conflict, true);
  assert.equal(result.groups[0].provenance.length, 2);
});

test("manager owners and non-repository provenance remain visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-provenance-"));
  const skill = await writeSkill(root, "review");
  const result = await discoverSkills({
    input: "review",
    roots: [],
    managerRecords: [
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: { kind: "local" },
        provenance: { kind: "registry", reference: "registry:review@1" },
      },
      {
        manager: "jtianling",
        name: "review",
        path: skill,
        source: { kind: "local" },
        provenance: { kind: "archive", reference: "https://example.test/review.zip" },
      },
    ],
  });

  assert.equal(result.groups[0].copies.length, 1);
  assert.equal(result.groups[0].copies[0].owner, "manager:xing");
  assert.deepEqual(
    result.groups[0].copies[0].owners.sort(),
    ["manager:jtianling", "manager:xing"],
  );
  assert.equal(result.groups[0].provenance.length, 2);
  assert.equal(result.groups[0].conflict, true);
  assert.ok(result.groups[0].evidence.every(({ provenance }) => provenance));
});

test("canonical upstream entrypoints participate in provenance conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstream-conflict-"));
  const skill = await writeSkill(root, "review");
  const repository = "https://github.com/example/skills";
  const result = await discoverSkills({
    input: "review",
    roots: [],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: { kind: "repository", repository, upstreamPath: "skills/review" },
      },
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: {
          kind: "repository",
          repository,
          upstream_path: "skills/other/SKILL.md",
        },
      },
    ],
  });

  assert.equal(result.groups[0].conflict, true);
  assert.deepEqual(
    result.groups[0].evidence.map(({ upstream_path }) => upstream_path).sort(),
    ["skills/other/SKILL.md", "skills/review/SKILL.md"],
  );
  assert.ok(result.groups[0].provenance.every((value) => value.includes("#skills/")));
});

test("repository discovery blocks when no local copy exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "missing-"));
  await assert.rejects(
    discoverSkills({
      input: "https://github.com/example/missing/tree/main/skills/review",
      roots: [{ path: root, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "NO_LOCAL_COPY",
  );
});

test("existing relative paths win over repository slugs and repository subdirs select exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "locator-"));
  const repository = path.join(root, "repo");
  const skillsRoot = path.join(repository, "skills");
  const first = await writeSkill(skillsRoot, "a");
  await writeSkill(skillsRoot, "b");
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repository, "remote", "add", "origin", "https://github.com/example/skills"]).status,
    0,
  );
  const relative = path.relative(process.cwd(), first);
  const byPath = await discoverSkills({
    input: relative,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });
  assert.equal(byPath.groups[0].name, "a");
  const bySubdir = await discoverSkills({
    input: "https://github.com/example/skills/tree/main/skills/a",
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });
  assert.deepEqual(bySubdir.groups.map(({ name }) => name), ["a"]);
});

test("an explicit skill nested below a configured root is always considered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-input-"));
  const skillsRoot = path.join(root, "skills");
  const nested = await writeSkill(path.join(skillsRoot, "team", "productivity"), "review");

  const result = await discoverSkills({
    input: nested,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies[0].path, nested);
  assert.equal(result.groups[0].evidence[0].kind, "explicit");
});

test("an existing relative filesystem path wins over repository-slug parsing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "path-or-slug-"));
  const existingPath = path.join(root, "team", "review");
  const library = path.join(root, "library");
  const installed = await writeSkill(library, "review");
  await mkdir(existingPath, { recursive: true });

  await assert.rejects(
    discoverSkills({
      input: "team/review",
      cwd: root,
      roots: [{ path: library, owner: "manager:asm", scope: "global" }],
      managerRecords: [
        {
          manager: "asm",
          name: "review",
          path: installed,
          source: {
            kind: "repository",
            repository: "https://github.com/team/review",
          },
        },
      ],
    }),
    (error) => error.code === "NO_LOCAL_COPY",
  );
});

test("confirmation is explicit, interactive, and last in the evidence order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "confirmation-"));
  const skill = await writeSkill(root, "review");
  const discovery = await discoverSkills({
    input: skill,
    roots: [{ path: root, owner: "custom", scope: "custom" }],
    managerRecords: [],
  });
  const choice = {
    name: discovery.groups[0].name,
    fingerprint: discovery.groups[0].fingerprint,
    path: discovery.groups[0].copies[0].path,
    owner: discovery.groups[0].copies[0].owner,
  };
  assert.throws(
    () => confirmDiscoverySelection({ discovery, choice, interactive: false }),
    (error) => error.code === "DISCOVERY_CONFIRMATION_REQUIRED",
  );
  const selected = confirmDiscoverySelection({ discovery, choice, interactive: true });
  assert.equal(selected.evidence.at(-1).kind, "confirmation");
});

test("confirmation can retain caller-provided audit evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "confirmation-audit-"));
  const skill = await writeSkill(root, "review");
  const discovery = await discoverSkills({
    input: skill,
    roots: [{ path: root, owner: "custom", scope: "custom" }],
    managerRecords: [],
  });
  const group = discovery.groups[0];
  const audit = {
    actor: "human",
    reason: "confirmed this unmanaged local source",
    at: "2026-08-04T00:00:00.000Z",
  };

  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: group.copies[0].path,
      owner: group.copies[0].owner,
    },
    interactive: true,
    confirmationEvidence: audit,
  });

  assert.deepEqual(selected.evidence.at(-1).confirmationEvidence, audit);
});

test("confirmation identifies groups by name plus fingerprint", () => {
  const shared = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const discovery = {
    groups: ["first", "second"].map((name) => ({
      name,
      fingerprint: shared,
      copies: [{
        path: `/${name}`,
        owner: "fixture",
        evidence: [],
        provenance: [],
        conflict: false,
      }],
      evidence: [],
      provenance: [],
      conflict: false,
    })),
  };
  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: "second",
      fingerprint: shared,
      path: "/second",
      owner: "fixture",
    },
    interactive: true,
  });
  assert.equal(selected.name, "second");
});

test("confirmation cannot pair one physical copy with another copy's provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copy-provenance-"));
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const first = await writeSkill(firstRoot, "review");
  await writeSkill(secondRoot, "review");
  const { spawnSync } = await import("node:child_process");
  for (const [repository, remote] of [
    [firstRoot, "https://github.com/example/first"],
    [secondRoot, "https://github.com/example/second"],
  ]) {
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    assert.equal(
      spawnSync("git", ["-C", repository, "remote", "add", "origin", remote]).status,
      0,
    );
  }
  const discovery = await discoverSkills({
    input: "review",
    roots: [
      { path: firstRoot, owner: "first", scope: "global" },
      { path: secondRoot, owner: "second", scope: "global" },
    ],
    managerRecords: [],
  });
  const group = discovery.groups[0];
  const firstCopy = group.copies.find(({ path: copyPath }) => copyPath === first);
  const otherProvenance = group.copies.find(({ owner }) => owner === "second")
    .provenance[0];

  assert.equal(group.conflict, true);
  assert.equal(firstCopy.conflict, false);
  assert.throws(
    () =>
      confirmDiscoverySelection({
        discovery,
        choice: {
          name: group.name,
          fingerprint: group.fingerprint,
          path: firstCopy.path,
          owner: firstCopy.owner,
        },
        interactive: true,
        confirmedProvenance: otherProvenance,
      }),
    (error) => error.code === "PROVENANCE_COPY_MISMATCH",
  );
  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: firstCopy.path,
      owner: firstCopy.owner,
    },
    interactive: true,
  });
  assert.equal(selected.provenance, firstCopy.provenance[0]);
});

test("active inventory deduplicates one physical source with multiple owners", () => {
  const inventory = activeSkillInventory({
    groups: [
      {
        name: "review",
        copies: [
          {
            path: "/cache/review",
            realPath: "/cache/review",
            owner: "plugin:codex",
            active: false,
          },
          {
            path: "/alias/review",
            realPath: "/source/review",
            owner: "plugin:codex",
            active: false,
          },
          { path: "/source/review", realPath: "/source/review", owner: "manager:asm" },
        ],
      },
    ],
  });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].realPath, "/source/review");
});

test("adjacent customization metadata is classified and malformed metadata is visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discovery-customization-metadata-"));
  const malformed = await writeSkill(root, "managed-overlay");
  await writeFile(path.join(malformed, "customization.json"), "{not-json\n");
  await assert.rejects(
    discoverSkills({ input: malformed, roots: [] }),
    (error) => error.code === "MALFORMED_CUSTOMIZATION_METADATA",
  );
});
