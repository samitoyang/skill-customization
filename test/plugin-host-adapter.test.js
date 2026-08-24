import assert from "node:assert/strict";
import {
  lstat as fsLstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath as fsRealpath,
  rm,
  stat as fsStat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeCodeAdapter } from "../src/plugin-host-adapters/claude-code.js";
import { createCodexAdapter } from "../src/plugin-host-adapters/codex.js";
import { createCursorAdapter } from "../src/plugin-host-adapters/cursor.js";
import { createGeminiCliAdapter } from "../src/plugin-host-adapters/gemini-cli.js";
import { pluginHostResult } from "../src/plugin-host-adapters/interface.js";
import { isPathContained } from "../src/paths.js";

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
    const cacheCalls = [];
    const installCalls = [];
    const readCalls = [];
    const diagnostics = [];
    const adapter = createCodexAdapter({
      addPluginInstall: async (options) => installCalls.push(options),
      diagnostic: (value) => value,
      discoverMarketplaceManifests: async (options) => marketplaceCalls.push(options),
      discoverVersionedPluginCache: async (options) => cacheCalls.push(options),
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
    assert.equal(installCalls.length, 1);
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
    assert.deepEqual(cacheCalls, [{
      cacheRoot,
      boundary: cacheRoot,
      context,
      host: "codex",
      scope: "global",
      active: false,
      manifestPolicy: {
        files: [".codex-plugin/plugin.json", "plugin.json", "manifest.json", "package.json"],
      },
      localPluginIdentity: cacheCalls[0].localPluginIdentity,
    }]);
    assert.equal(
      installCalls[0].localPluginIdentity({
        host: "codex",
        marketplace: "local",
        name: "direct",
      }),
      "local:plugin:codex:local:direct",
    );
    assert.equal(
      cacheCalls[0].localPluginIdentity({
        host: "codex",
        marketplace: "official",
        name: "reviewer",
      }),
      "local:plugin:codex:official:reviewer",
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
    assert.ok(marketplaceCalls.every(({ manifestFiles }) =>
      JSON.stringify(manifestFiles) === JSON.stringify([
        "marketplace.json",
        "plugins.json",
        "manifest.json",
      ])));
    assert.ok(diagnostics.some(({ code }) => code === "MALFORMED_PLUGIN_CONFIGURATION"));
    assert.equal(
      marketplaceCalls.at(-1).base,
      path.join(configuredRoot, ".agents", "plugins"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini CLI adapter interface owns locations, validation, and activation policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemini-cli-adapter-interface-"));
  try {
    const home = path.join(root, "home");
    const configuredHome = path.join(root, "configured-home");
    const cwd = path.join(root, "workspace");
    const globalRoot = path.join(
      configuredHome,
      ".gemini",
      "extensions",
    );
    const globalExtension = path.join(globalRoot, "global-extension");
    const workspaceRoot = path.join(cwd, ".gemini", "extensions");
    const workspaceExtension = path.join(workspaceRoot, "workspace-extension");
    await mkdir(cwd, { recursive: true });

    const directoryCalls = [];
    const installCalls = [];
    const installOutcomes = [];
    const manifestFixtures = new Map([
      [globalExtension, {
        status: "valid",
        value: { name: "global-extension", version: "1.0.0" },
        path: path.join(globalExtension, "gemini-extension.json"),
      }],
      [workspaceExtension, {
        status: "valid",
        value: { name: "wrong-name", version: "1.0.0" },
        path: path.join(workspaceExtension, "gemini-extension.json"),
      }],
    ]);
    const adapter = createGeminiCliAdapter({
      addPluginInstall: async (options) => {
        installCalls.push(options);
        const validation = await options.manifestValidation({
          manifest: manifestFixtures.get(options.installRoot),
          safeInstallRoot: options.installRoot,
          initialMetadata: {
            host: options.host,
            marketplace: options.marketplace,
            name: options.name,
            root: options.installRoot,
          },
          context: options.context,
        });
        const included = validation?.include === true;
        installOutcomes.push({
          installRoot: options.installRoot,
          included,
          installationMetadata: validation?.installationMetadata,
          diagnostics: options.context.diagnostics.slice(),
        });
        if (included) {
          options.context.roots.push({
            kind: "plugin",
            path: options.installRoot,
            owner: "plugin:gemini-cli",
            scope: options.scope,
            origin: "plugin",
            host: options.host,
          });
        }
        return included;
      },
      diagnostic: (value) => value,
      pluginDirectories: async (target) => {
        directoryCalls.push(target);
        if (target === globalRoot) {
          return [{ entry: { name: "global-extension" }, path: globalExtension }];
        }
        if (target === workspaceRoot) {
          return [{ entry: { name: "workspace-extension" }, path: workspaceExtension }];
        }
        return [];
      },
      readJsonObject: async (file) => {
        if (!file.endsWith(".gemini-extension-install.json")) return undefined;
        return file === path.join(globalExtension, ".gemini-extension-install.json")
          ? { source: "https://github.com/example/extension", type: "git" }
          : { source: "not-a-supported-source", type: "unsupported" };
      },
      safeDirectory: async (target) => target,
    });
    const context = {
      home,
      cwd,
      env: { GEMINI_CLI_HOME: configuredHome },
      workspaceDirectories: [cwd],
      roots: [],
      diagnostics: [],
    };

    const result = await adapter.discover(context);

    assert.equal(context.host, "gemini-cli");
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0].path, globalExtension);
    assert.equal(result.diagnostics.length, 2);
    assert.deepEqual(directoryCalls, [globalRoot, workspaceRoot]);
    assert.deepEqual(
      installCalls.map(({ installRoot, boundary, host, marketplace, scope, active }) => ({
        installRoot,
        boundary,
        host,
        marketplace,
        scope,
        active,
      })),
      [
        {
          installRoot: globalExtension,
          boundary: globalRoot,
          host: "gemini-cli",
          marketplace: "local",
          scope: "global",
          active: true,
        },
        {
          installRoot: workspaceExtension,
          boundary: workspaceRoot,
          host: "gemini-cli",
          marketplace: "local",
          scope: "workspace",
          active: true,
        },
      ],
    );
    assert.deepEqual(
      installOutcomes.map(({ installRoot, included, installationMetadata, diagnostics }) => ({
        installRoot,
        included,
        installationMetadata,
        diagnosticCodes: diagnostics.map(({ code }) => code),
      })),
      [
        {
          installRoot: globalExtension,
          included: true,
          installationMetadata: {
            source: "https://github.com/example/extension",
            type: "git",
          },
          diagnosticCodes: [],
        },
        {
          installRoot: workspaceExtension,
          included: false,
          installationMetadata: undefined,
          diagnosticCodes: [
            "INVALID_PLUGIN_METADATA",
            "INVALID_PLUGIN_INSTALL_METADATA",
          ],
        },
      ],
    );
    assert.deepEqual(installCalls[0].manifestPolicy, {
      files: ["gemini-extension.json"],
      description: "Gemini extension metadata",
    });
    assert.equal(
      result.diagnostics.some(({ message }) =>
        message.includes("must match its extension directory")),
      true,
    );
    assert.equal(
      result.diagnostics.some(({ message }) =>
        message.includes("invalid Gemini extension installation metadata")),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor adapter interface uses isolated filesystem fixtures and normalized observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-adapter-interface-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const cursorHome = path.join(home, ".cursor");
    const globalRoot = path.join(cursorHome, "plugins", "local");
    const workspaceRoot = path.join(cwd, ".cursor", "plugins", "local");
    const marketplaceRoot = path.join(globalRoot, "team-marketplace");
    const marketplaceFile = path.join(
      marketplaceRoot,
      ".cursor-plugin",
      "marketplace.json",
    );
    const marketplacePlugin = path.join(
      marketplaceRoot,
      "plugins",
      "marketed-plugin",
    );
    const marketplacePluginManifest = path.join(
      marketplacePlugin,
      ".cursor-plugin",
      "plugin.json",
    );
    const marketplaceSkill = path.join(
      marketplacePlugin,
      "custom-skills",
      "cursor-market-review",
      "SKILL.md",
    );
    const invalidPlugin = path.join(workspaceRoot, "invalid-plugin");
    const invalidPluginManifest = path.join(
      invalidPlugin,
      ".cursor-plugin",
      "plugin.json",
    );
    const escapedPlugin = path.join(cwd, "outside-plugin");
    const escapedPluginLink = path.join(workspaceRoot, "escaped-plugin");

    const writeJson = async (file, value) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    };
    const writeSkill = async (file, name) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `---\nname: ${name}\ndescription: Fixture\n---\nUse this skill.\n`,
      );
    };

    await Promise.all([
      mkdir(globalRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeJson(marketplaceFile, {
      name: "team-marketplace",
      owner: { name: "fixture" },
      metadata: { pluginRoot: "plugins" },
      plugins: [{ name: "marketed-plugin", source: "marketed-plugin" }],
    });
    await writeJson(marketplacePluginManifest, {
      name: "marketed-plugin",
      version: "1.0.0",
      skills: "custom-skills",
    });
    await writeSkill(marketplaceSkill, "cursor-market-review");
    await writeJson(invalidPluginManifest, {
      name: "Invalid Plugin",
      skills: "skills",
    });
    await writeSkill(
      path.join(invalidPlugin, "skills", "ignored-review", "SKILL.md"),
      "ignored-review",
    );
    await writeJson(
      path.join(escapedPlugin, ".cursor-plugin", "plugin.json"),
      { name: "escaped-plugin" },
    );
    await writeSkill(
      path.join(escapedPlugin, "skills", "escaped-review", "SKILL.md"),
      "escaped-review",
    );
    await symlink(escapedPlugin, escapedPluginLink, "dir");

    const directoryCalls = [];
    const installCalls = [];
    const marketplaceCalls = [];
    const readFiles = [];
    const diagnostic = ({ host, path: file, code, message, metadata }) => ({
      kind: "plugin",
      host,
      path: path.resolve(file),
      code,
      message,
      ...(metadata ? { plugin: structuredClone(metadata) } : {}),
    });
    const pluginIdentity = ({ host, marketplace, name }) =>
      `local:plugin:${host}:${marketplace}:${name}`;
    const canonicalContained = async (candidate, boundary) => {
      try {
        const [canonicalCandidate, canonicalBoundary] = await Promise.all([
          fsRealpath(candidate),
          fsRealpath(boundary),
        ]);
        return isPathContained(canonicalBoundary, canonicalCandidate);
      } catch {
        return false;
      }
    };
    const safeDirectory = async (
      target,
      boundary,
      context,
      metadata,
      { declared = false } = {},
    ) => {
      const resolvedTarget = path.resolve(target);
      const resolvedBoundary = path.resolve(boundary);
      if (!isPathContained(resolvedBoundary, resolvedTarget)) {
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: "PLUGIN_ROOT_ESCAPE",
          message: `plugin path escapes its declared root: ${resolvedTarget}`,
          metadata,
        }));
        return undefined;
      }
      let info;
      try {
        info = await fsLstat(resolvedTarget);
      } catch (error) {
        if (error.code === "ENOENT" && !declared) return undefined;
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: error.code === "ENOENT" ? "PLUGIN_ROOT_MISSING" : "PLUGIN_ROOT_UNREADABLE",
          message: `cannot inspect plugin path ${resolvedTarget}: ${error.message}`,
          metadata,
        }));
        return undefined;
      }
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: "PLUGIN_ROOT_NOT_DIRECTORY",
          message: `plugin skill root is not a directory: ${resolvedTarget}`,
          metadata,
        }));
        return undefined;
      }
      if (!(await canonicalContained(resolvedTarget, resolvedBoundary))) {
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: "PLUGIN_ROOT_ESCAPE",
          message: `plugin path resolves outside its declared root: ${resolvedTarget}`,
          metadata,
        }));
        return undefined;
      }
      if (info.isSymbolicLink() && !(await fsStat(resolvedTarget)).isDirectory()) {
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: "PLUGIN_ROOT_NOT_DIRECTORY",
          message: `plugin skill root is not a directory: ${resolvedTarget}`,
          metadata,
        }));
        return undefined;
      }
      return resolvedTarget;
    };
    const readJsonObject = async (
      file,
      context,
      {
        host = context.host,
        metadata,
        description = "plugin metadata",
        boundary,
      } = {},
    ) => {
      if (boundary) {
        try {
          await fsLstat(file);
        } catch (error) {
          if (error.code === "ENOENT") return undefined;
          context.diagnostics.push(diagnostic({
            host,
            path: file,
            code: "PLUGIN_METADATA_UNREADABLE",
            message: `cannot inspect ${description} ${file}: ${error.message}`,
            metadata,
          }));
          return undefined;
        }
        if (!(await canonicalContained(file, boundary))) {
          context.diagnostics.push(diagnostic({
            host,
            path: file,
            code: "PLUGIN_METADATA_ESCAPE",
            message: `${description} resolves outside its extension root: ${file}`,
            metadata,
          }));
          return undefined;
        }
      }
      let contents;
      try {
        contents = await readFile(file, "utf8");
        readFiles.push(file);
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        context.diagnostics.push(diagnostic({
          host,
          path: file,
          code: "PLUGIN_METADATA_UNREADABLE",
          message: `cannot read ${description} ${file}: ${error.message}`,
          metadata,
        }));
        return undefined;
      }
      try {
        const value = JSON.parse(contents);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("metadata must be a JSON object");
        }
        return value;
      } catch (error) {
        context.diagnostics.push(diagnostic({
          host,
          path: file,
          code: "MALFORMED_PLUGIN_METADATA",
          message: `malformed ${description} ${file}: ${error.message}`,
          metadata,
        }));
        return undefined;
      }
    };
    const pluginDirectories = async (target, context, metadata) => {
      directoryCalls.push(target);
      let entries;
      try {
        entries = await readdir(target, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return [];
        context.diagnostics.push(diagnostic({
          host: context.host,
          path: target,
          code: "PLUGIN_ROOT_UNREADABLE",
          message: `cannot read documented plugin root ${target}: ${error.message}`,
          metadata,
        }));
        return [];
      }
      const result = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = await safeDirectory(
          path.join(target, entry.name),
          target,
          context,
          metadata,
        );
        if (candidate) result.push({ entry, path: candidate });
      }
      return result;
    };
    const readManifest = async (installRoot, context, manifestPolicy) => {
      for (const relative of manifestPolicy.files) {
        const file = path.join(installRoot, relative);
        try {
          await fsLstat(file);
        } catch (error) {
          if (error.code === "ENOENT") continue;
        }
        const value = await readJsonObject(file, context, {
          host: context.host,
          description: manifestPolicy.description,
          boundary: installRoot,
        });
        if (value) return { status: "valid", value, path: file };
        return { status: "invalid", path: file };
      }
      return { status: "missing" };
    };
    const addPluginInstall = async (options) => {
      installCalls.push(options);
      const manifestPolicy = options.manifestPolicy ?? {};
      const initialMetadata = {
        host: options.host,
        marketplace: options.marketplace,
        name: options.name,
        root: path.resolve(options.installRoot),
      };
      const safeInstallRoot = await safeDirectory(
        options.installRoot,
        options.boundary,
        options.context,
        initialMetadata,
      );
      if (!safeInstallRoot) return false;
      const manifest = await readManifest(
        safeInstallRoot,
        options.context,
        manifestPolicy,
      );
      let invalidManifest = manifest.status === "invalid";
      const manifestValue = manifest.status === "valid" ? manifest.value : undefined;
      if (manifest.status === "missing" && manifestPolicy.requiredFields?.length > 0) {
        invalidManifest = true;
        options.context.diagnostics.push(diagnostic({
          host: options.host,
          path: safeInstallRoot,
          code: "MISSING_PLUGIN_METADATA",
          message: `missing ${manifestPolicy.description} in ${safeInstallRoot}`,
          metadata: initialMetadata,
        }));
      }
      for (const field of manifestPolicy.requiredFields ?? []) {
        if (manifestValue && typeof manifestValue[field] === "string" && manifestValue[field].trim()) {
          continue;
        }
        if (!manifestValue) break;
        invalidManifest = true;
        options.context.diagnostics.push(diagnostic({
          host: options.host,
          path: manifest.path,
          code: "INVALID_PLUGIN_METADATA",
          message: `${manifestPolicy.description} is missing a valid ${field}: ${manifest.path}`,
          metadata: initialMetadata,
        }));
      }
      if (
        manifestValue
        && manifestPolicy.manifestNamePattern
        && typeof manifestValue.name === "string"
        && !manifestPolicy.manifestNamePattern.test(manifestValue.name)
      ) {
        invalidManifest = true;
        options.context.diagnostics.push(diagnostic({
          host: options.host,
          path: manifest.path,
          code: "INVALID_PLUGIN_METADATA",
          message: `${manifestPolicy.description} has an invalid plugin name: ${manifest.path}`,
          metadata: initialMetadata,
        }));
      }
      if (manifestPolicy.skipInvalidExtension && invalidManifest) return false;

      const metadata = {
        ...initialMetadata,
        ...(manifestValue?.name ? { name: manifestValue.name } : {}),
        ...(manifestValue?.version ? { version: manifestValue.version } : {}),
        root: safeInstallRoot,
        ...(manifest.path ? { manifestPath: manifest.path } : {}),
      };
      const declaredSkillDirectory = manifestValue?.skills;
      const directories = declaredSkillDirectory === undefined
        ? ["skills"]
        : typeof declaredSkillDirectory === "string"
          ? [declaredSkillDirectory]
          : Array.isArray(declaredSkillDirectory)
            ? declaredSkillDirectory
            : [];
      let addedRoot = false;
      for (const relativeDirectory of directories) {
        if (typeof relativeDirectory !== "string" || !relativeDirectory.trim()) continue;
        const skillRoot = await safeDirectory(
          path.isAbsolute(relativeDirectory)
            ? relativeDirectory
            : path.resolve(safeInstallRoot, relativeDirectory),
          safeInstallRoot,
          options.context,
          metadata,
          { declared: relativeDirectory !== "skills" },
        );
        if (!skillRoot) continue;
        const identity = options.localPluginIdentity(metadata);
        options.context.roots.push({
          kind: "plugin",
          path: skillRoot,
          owner: "plugin:cursor",
          owners: ["plugin:cursor"],
          scope: options.scope,
          origin: "plugin",
          host: "cursor",
          plugin: {
            host: metadata.host,
            marketplace: metadata.marketplace,
            name: metadata.name,
            ...(metadata.version ? { version: metadata.version } : {}),
          },
          pluginMetadata: metadata,
          pluginIdentity: identity,
          pluginEvidence: [{
            kind: "plugin",
            host: metadata.host,
            plugin: metadata.name,
            marketplace: metadata.marketplace,
            ...(metadata.version ? { version: metadata.version } : {}),
            identity,
            provenance: {
              kind: "plugin",
              host: metadata.host,
              plugin: metadata.name,
              marketplace: metadata.marketplace,
              ...(metadata.version ? { version: metadata.version } : {}),
            },
          }],
          pluginRoot: safeInstallRoot,
          ...(manifest.path ? { pluginManifest: manifest.path } : {}),
          includeRootSkill: relativeDirectory !== "skills"
            || manifestPolicy.includeDefaultSkillRoot !== false,
        });
        addedRoot = true;
      }
      return addedRoot;
    };
    const discoverMarketplaceManifests = async (options) => {
      marketplaceCalls.push(options);
      const safeBase = await safeDirectory(
        options.base,
        options.boundary,
        options.context,
        { host: options.host, source: "marketplace" },
      );
      if (!safeBase) return false;
      let file;
      let manifest;
      for (const relative of options.manifestFiles) {
        const candidate = path.join(safeBase, relative);
        try {
          await fsLstat(candidate);
        } catch (error) {
          if (error.code === "ENOENT") continue;
        }
        manifest = await readJsonObject(candidate, options.context, {
          host: options.host,
          description: "marketplace metadata",
          boundary: safeBase,
        });
        if (!manifest) return false;
        file = candidate;
        break;
      }
      if (!file) return false;
      const sourceBase = options.marketplaceRootDirectories.includes(path.basename(path.dirname(file)))
        ? path.dirname(path.dirname(file))
        : safeBase;
      const marketplace = manifest.name ?? options.marketplaceName ?? path.basename(safeBase);
      const validation = await options.marketplacePolicy.validate({
        manifest,
        file,
        safeBase,
        sourceBase,
        context: options.context,
        host: options.host,
        marketplace,
      });
      if (!validation?.valid) return false;
      const declaredPluginRoot = validation.pluginRoot
        ? await safeDirectory(
            path.resolve(sourceBase, validation.pluginRoot),
            sourceBase,
            options.context,
            { host: options.host, marketplace, source: "marketplace" },
            { declared: true },
          )
        : undefined;
      if (validation.pluginRoot && !declaredPluginRoot) return false;
      let declaredPlugin = false;
      for (const entry of validation.entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (
          options.marketplacePolicy.validateEntry
          && !(await options.marketplacePolicy.validateEntry({
            entry,
            file,
            context: options.context,
            marketplace,
          }))
        ) continue;
        const configuredPath = entry.path
          ?? entry.directory
          ?? entry.root
          ?? entry.installPath
          ?? (typeof entry.source === "string" ? entry.source : undefined);
        if (typeof configuredPath !== "string" || !configuredPath.trim()) continue;
        const boundary = declaredPluginRoot ?? sourceBase;
        const installRoot = path.resolve(boundary, configuredPath);
        declaredPlugin = true;
        await options.onDeclaredPlugin?.({
          location: { installRoot, boundary },
          entry,
          file,
          context: options.context,
        });
        await addPluginInstall({
          installRoot,
          boundary,
          host: options.host,
          marketplace,
          name: entry.name,
          version: entry.version,
          scope: options.scope,
          source: entry,
          declaration: { ...entry, sourceType: "marketplace", marketplace },
          context: options.context,
          active: options.active,
          manifestPolicy: options.manifestPolicy,
          localPluginIdentity: options.localPluginIdentity,
        });
      }
      return declaredPlugin;
    };
    const adapter = createCursorAdapter({
      addPluginInstall,
      canonicalContained,
      diagnostic,
      discoverMarketplaceManifests,
      lstat: fsLstat,
      pluginDirectories,
      pluginIdentity,
      realpath: fsRealpath,
      safeDirectory,
    });
    const context = {
      home,
      cwd,
      env: { CURSOR_HOME: cursorHome },
      workspaceDirectories: [cwd],
      roots: [],
      diagnostics: [],
    };

    const result = await adapter.discover(context);

    assert.equal(context.host, "cursor");
    assert.equal(result.roots.length, context.roots.length);
    assert.equal(result.diagnostics.length, context.diagnostics.length);
    assert.deepEqual(directoryCalls, [globalRoot, workspaceRoot]);
    assert.deepEqual(
      marketplaceCalls.map(({ base, boundary, scope, marketplaceName, active }) => ({
        base,
        boundary,
        scope,
        marketplaceName,
        active,
      })),
      [
        {
          base: globalRoot,
          boundary: cursorHome,
          scope: "global",
          marketplaceName: "local",
          active: true,
        },
        {
          base: marketplaceRoot,
          boundary: globalRoot,
          scope: "global",
          marketplaceName: "local",
          active: true,
        },
        {
          base: workspaceRoot,
          boundary: cwd,
          scope: "workspace",
          marketplaceName: "local",
          active: true,
        },
      ],
    );
    const marketplaceOptions = marketplaceCalls[1];
    assert.equal(
      marketplaceOptions.manifestFiles[0],
      ".cursor-plugin/marketplace.json",
    );
    assert.deepEqual(marketplaceOptions.marketplaceRootDirectories, [".cursor-plugin"]);
    assert.deepEqual(marketplaceOptions.manifestPolicy, {
      files: [".cursor-plugin/plugin.json", "plugin.json"],
      description: "Cursor plugin metadata",
      requiredFields: ["name"],
      skipInvalidExtension: true,
      manifestOverridesDeclaration: true,
      declaredSkillDirectoriesReplaceDefault: true,
      includeRootSkillFallback: true,
      includeDefaultSkillRoot: false,
      manifestNamePattern: marketplaceOptions.manifestPolicy.manifestNamePattern,
    });
    assert.equal(readFiles.includes(marketplaceFile), true);
    assert.equal(readFiles.includes(marketplacePluginManifest), true);
    assert.deepEqual(result.roots.map(({ path: rootPath }) => rootPath), [
      path.dirname(path.dirname(marketplaceSkill)),
    ]);
    assert.deepEqual(result.roots[0].plugin, {
      host: "cursor",
      marketplace: "team-marketplace",
      name: "marketed-plugin",
      version: "1.0.0",
    });
    assert.deepEqual(result.roots[0].pluginMetadata, {
      host: "cursor",
      marketplace: "team-marketplace",
      name: "marketed-plugin",
      version: "1.0.0",
      root: marketplacePlugin,
      manifestPath: marketplacePluginManifest,
    });
    assert.equal(result.roots[0].pluginManifest, marketplacePluginManifest);
    assert.equal(result.roots[0].pluginIdentity, "local:plugin:cursor:team-marketplace:marketed-plugin");
    assert.match(
      await readFile(
        path.join(result.roots[0].path, "cursor-market-review", "SKILL.md"),
        "utf8",
      ),
      /cursor-market-review/,
    );
    assert.ok(installCalls.every(({ host }) => host === "cursor"));
    assert.equal(
      installCalls.some(({ marketplace, name }) =>
        marketplace === "team-marketplace" && name === "marketed-plugin"),
      true,
    );
    assert.equal(
      result.diagnostics.some(({ code, path: diagnosticPath }) =>
        code === "INVALID_PLUGIN_METADATA" && diagnosticPath === invalidPluginManifest),
      true,
    );
    assert.equal(
      result.diagnostics.some(({ code, path: diagnosticPath }) =>
        code === "PLUGIN_ROOT_ESCAPE" && diagnosticPath === escapedPluginLink),
      true,
    );
    assert.equal(result.roots.some(({ path: rootPath }) => rootPath.startsWith(escapedPlugin)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin host results clone and freeze nested observations", () => {
  const root = {
    kind: "plugin",
    path: "/fixture/plugin",
    owner: "plugin:future-host",
    scope: "global",
    origin: "plugin",
    host: "future-host",
    plugin: { name: "future" },
    pluginEvidence: [{
      kind: "plugin",
      host: "future-host",
      plugin: "future",
      marketplace: "local",
    }],
  };
  const result = pluginHostResult({
    roots: [root],
    diagnostics: [],
  });

  root.plugin.name = "mutated-after-return";
  assert.equal(result.roots[0].plugin.name, "future");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.roots), true);
  assert.equal(Object.isFrozen(result.roots[0]), true);
  assert.equal(Object.isFrozen(result.roots[0].plugin), true);
  assert.equal(Object.isFrozen(result.roots[0].pluginEvidence[0]), true);
});
