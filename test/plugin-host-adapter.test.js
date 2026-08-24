import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "../src/plugin-host-adapters/claude-code.js";

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

    await adapter.discover(context);

    assert.equal(context.host, "claude-code");
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
