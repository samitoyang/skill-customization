import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "../src/plugin-host-adapters/claude-code.js";
import { createCodexAdapter } from "../src/plugin-host-adapters/codex.js";

test("Claude Code adapter interface uses injected local filesystem helpers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-adapter-interface-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const claudeHome = path.join(home, ".claude");
    const pluginsRoot = path.join(claudeHome, "plugins");
    const cacheRoot = path.join(pluginsRoot, "cache");
    const marketplaceRoot = path.join(pluginsRoot, "marketplaces", "team");
    const installRoot = path.join(cacheRoot, "official", "reviewer", "1.0.0");
    await mkdir(cwd, { recursive: true });

    const cacheCalls = [];
    const marketplaceCalls = [];
    const installCalls = [];
    const adapter = createClaudeCodeAdapter({
      addPluginInstall: async (options) => installCalls.push(options),
      canonicalContained: async () => true,
      diagnostic: (value) => value,
      discoverMarketplaceManifests: async (options) => marketplaceCalls.push(options),
      discoverVersionedPluginCache: async (options) => cacheCalls.push(options),
      metadataFor: (value) => value,
      pluginDirectories: async (target) => target === path.join(pluginsRoot, "marketplaces")
        ? [{ entry: { name: "team" }, path: marketplaceRoot }]
        : [],
      pluginEvidence: ({ metadata }) => ({ evidence: { kind: "plugin", ...metadata } }),
      pluginIdentity: ({ host, marketplace, name }) =>
        `local:plugin:${host}:${marketplace}:${name}`,
      readJsonObject: async (file) => path.basename(file) === "installed_plugins.json"
        ? {
          plugins: {
            "reviewer@official": [{
              scope: "user",
              installPath: installRoot,
              version: "1.0.0",
            }],
          },
        }
        : undefined,
      realpath: async (target) => target,
      safeDirectory: async (target) => target,
      stat: async () => ({ isDirectory: () => true }),
    });
    const context = {
      home,
      cwd,
      env: {
        CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_CODE_SYNC_SKILLS: "0",
      },
      workspaceDirectories: [cwd],
      roots: [],
      diagnostics: [],
    };

    const result = await adapter.discover(context);

    assert.equal(context.host, "claude-code");
    assert.equal(result.roots.length, context.roots.length);
    assert.equal(result.diagnostics.length, context.diagnostics.length);
    assert.equal(cacheCalls.length, 1);
    assert.equal(cacheCalls[0].host, "claude-code");
    assert.equal(cacheCalls[0].manifestPolicy.files[0], ".claude-plugin/plugin.json");
    assert.equal(marketplaceCalls.length, 1);
    assert.equal(marketplaceCalls[0].active, false);
    assert.deepEqual(marketplaceCalls[0].marketplaceRootDirectories, [".claude-plugin"]);
    assert.equal(marketplaceCalls[0].manifestFiles[0], ".claude-plugin/marketplace.json");
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].host, "claude-code");
    assert.equal(installCalls[0].scope, "global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter interface owns bounded locations, catalogs, and configuration policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-adapter-interface-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const codexHome = path.join(home, ".codex");
    const pluginsRoot = path.join(codexHome, "plugins");
    const cacheRoot = path.join(pluginsRoot, "cache");
    const cacheMarketplaceRoot = path.join(cacheRoot, "official");
    const cachePluginRoot = path.join(cacheMarketplaceRoot, "reviewer");
    const cacheVersionRoot = path.join(cachePluginRoot, "1.0.0");
    const bundledMarketplacesRoot = path.join(codexHome, ".tmp", "bundled-marketplaces");
    const configuredRoot = path.join(codexHome, "configured");
    await mkdir(cwd, { recursive: true });

    const marketplaceCalls = [];
    const installCalls = [];
    const readCalls = [];
    const diagnostics = [];
    const adapter = createCodexAdapter({
      addPluginInstall: async (options) => installCalls.push(options),
      diagnostic: (value) => value,
      discoverMarketplaceManifests: async (options) => marketplaceCalls.push(options),
      pluginDirectories: async (target) => {
        if (target === pluginsRoot) {
          return [{
            entry: { name: "direct" },
            path: path.join(pluginsRoot, "direct"),
          }];
        }
        if (target === cacheRoot) {
          return [{ entry: { name: "official" }, path: cacheMarketplaceRoot }];
        }
        if (target === cacheMarketplaceRoot) {
          return [{ entry: { name: "reviewer" }, path: cachePluginRoot }];
        }
        if (target === cachePluginRoot) {
          return [{ entry: { name: "1.0.0" }, path: cacheVersionRoot }];
        }
        if (target === bundledMarketplacesRoot) {
          return [{
            entry: { name: "bundled" },
            path: path.join(bundledMarketplacesRoot, "bundled"),
          }];
        }
        return [];
      },
      readFile: async (file, encoding) => {
        readCalls.push({ file, encoding });
        return `[marketplaces.team]\nsource_type = "local"\nsource = "configured"\n\n[marketplaces.broken]\nsource_type = local\nsource = "configured"\n`;
      },
      safeDirectory: async (target) => target,
    });
    const context = {
      home,
      cwd,
      env: { CODEX_HOME: codexHome },
      workspaceDirectories: [cwd],
      roots: [],
      diagnostics,
    };

    const result = await adapter.discover(context);

    assert.equal(context.host, "codex");
    assert.equal(result.roots.length, context.roots.length);
    assert.equal(result.diagnostics.length, context.diagnostics.length);
    assert.deepEqual(readCalls, [{
      file: path.join(codexHome, "config.toml"),
      encoding: "utf8",
    }]);
    assert.equal(installCalls.length, 2);
    assert.deepEqual(installCalls[0], {
      installRoot: path.join(pluginsRoot, "direct"),
      boundary: pluginsRoot,
      host: "codex",
      marketplace: "local",
      name: "direct",
      scope: "global",
      source: {},
      active: true,
      context,
      manifestPolicy: {
        files: [".codex-plugin/plugin.json", "plugin.json", "manifest.json", "package.json"],
      },
      localPluginIdentity: installCalls[0].localPluginIdentity,
    });
    assert.deepEqual(installCalls[1], {
      installRoot: cacheVersionRoot,
      boundary: cacheRoot,
      host: "codex",
      marketplace: "official",
      name: "reviewer",
      version: "1.0.0",
      scope: "global",
      source: {},
      cache: { kind: "versioned", scope: "global" },
      active: false,
      context,
      manifestPolicy: {
        files: [".codex-plugin/plugin.json", "plugin.json", "manifest.json", "package.json"],
      },
      localPluginIdentity: installCalls[1].localPluginIdentity,
    });
    assert.equal(
      installCalls[0].localPluginIdentity({
        host: "codex",
        marketplace: "local",
        name: "direct",
      }),
      "local:plugin:codex:local:direct",
    );
    assert.deepEqual(
      marketplaceCalls.map(({ marketplaceName, scope, active }) => ({
        marketplaceName,
        scope,
        active,
      })),
      [
        { marketplaceName: "personal", scope: "global", active: false },
        { marketplaceName: undefined, scope: "global", active: false },
        { marketplaceName: "bundled", scope: "global", active: false },
        { marketplaceName: undefined, scope: "workspace", active: false },
        { marketplaceName: "team", scope: "global", active: false },
      ],
    );
    assert.ok(marketplaceCalls.every(({ localPluginIdentity: identity }) =>
      identity({ host: "codex", marketplace: "team", name: "reviewer" })
        === "local:plugin:codex:team:reviewer"));
    assert.ok(marketplaceCalls.every(({ manifestPolicy }) =>
      manifestPolicy.files[0] === ".codex-plugin/plugin.json"));
    assert.ok(diagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_CONFIGURATION"));
    assert.equal(
      marketplaceCalls.at(-1).base,
      path.join(configuredRoot, ".agents", "plugins"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
