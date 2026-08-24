import path from "node:path";

import { isPathContained } from "../paths.js";

const GENERIC_MANIFEST_FILES = [
  "plugin.json",
  "manifest.json",
  "package.json",
];

const CLAUDE_MANIFEST_POLICY = Object.freeze({
  files: [".claude-plugin/plugin.json", ...GENERIC_MANIFEST_FILES],
});

const CLAUDE_MARKETPLACE_MANIFEST_FILES = [
  ".claude-plugin/marketplace.json",
  "marketplace.json",
  "plugins.json",
  "manifest.json",
];

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * @typedef {object} ClaudeCodeAdapterContext
 * @property {string} home
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {readonly string[]} workspaceDirectories
 * @property {string} [host]
 * @property {object[]} roots
 * @property {object[]} diagnostics
 */

/**
 * Create the Claude Code host adapter from the shared plugin observation
 * primitives. The adapter owns Claude-specific paths, records, and policies;
 * the injected functions only normalize and emit host-independent observations.
 *
 * @param {object} toolkit
 * @returns {{host: string, discover: (context: ClaudeCodeAdapterContext) => Promise<void>}}
 */
export function createClaudeCodeAdapter({
  addPluginInstall,
  canonicalContained,
  diagnostic,
  discoverMarketplaceManifests,
  discoverVersionedPluginCache,
  metadataFor,
  pluginDirectories,
  pluginEvidence,
  pluginIdentity,
  readJsonObject,
  realpath,
  safeDirectory,
  stat,
}) {
  async function addSyncedRoot({ root: syncedRoot, context }) {
    const metadata = metadataFor({
      host: "claude-code",
      marketplace: "synced",
      name: "synced",
      root: syncedRoot,
      source: "sync",
    });
    const safeRoot = await safeDirectory(
      syncedRoot,
      context.claudeHome,
      context,
      metadata,
    );
    if (!safeRoot) return;
    const evidence = pluginEvidence({ metadata, source: {} }).evidence;
    context.roots.push({
      kind: "plugin",
      path: safeRoot,
      owner: "plugin:claude-code",
      owners: ["plugin:claude-code"],
      scope: "global",
      origin: "plugin",
      host: "claude-code",
      plugin: {
        host: "claude-code",
        marketplace: "synced",
        name: "synced",
      },
      pluginMetadata: metadata,
      pluginIdentity: pluginIdentity(metadata),
      pluginEvidence: [
        {
          ...evidence,
          synced: true,
        },
      ],
      pluginRoot: safeRoot,
    });
  }

  async function claudeInstalledMetadata({ claudePluginsRoot, context }) {
    const results = [];
    for (const filename of ["installed_plugins.json", "known_marketplaces.json"]) {
      const file = path.join(claudePluginsRoot, filename);
      const value = await readJsonObject(file, context, {
        host: "claude-code",
        description: "Claude installation metadata",
      });
      if (value) results.push({ file, value, kind: filename });
    }
    return results;
  }

  function installedEntries(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const plugins = value.plugins ?? value.installations ?? value.extensions;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
    return Object.entries(plugins).flatMap(([key, entries]) => {
      const values = Array.isArray(entries) ? entries : [entries];
      const separator = key.lastIndexOf("@");
      const name = separator > 0 ? key.slice(0, separator) : key;
      const marketplace = separator > 0 ? key.slice(separator + 1) : "local";
      return values
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          ...entry,
          name: entry.name ?? name,
          marketplace: entry.marketplace ?? marketplace,
        }));
    });
  }

  async function claudeInstalledScope({ entry, metadataFile, context }) {
    const declaredScope = stringValue(entry.scope) ?? "user";
    if (declaredScope === "user") return "global";
    if (declaredScope !== "project" && declaredScope !== "local") {
      context.diagnostics.push(
        diagnostic({
          host: "claude-code",
          path: metadataFile,
          code: "INVALID_PLUGIN_INSTALL_METADATA",
          message: `Claude plugin installation has an invalid scope: ${metadataFile}`,
          metadata: { host: "claude-code", name: entry.name, scope: entry.scope },
        }),
      );
      return undefined;
    }
    const projectPath = stringValue(entry.projectPath ?? entry.project_path);
    if (!projectPath || !path.isAbsolute(projectPath)) {
      context.diagnostics.push(
        diagnostic({
          host: "claude-code",
          path: metadataFile,
          code: "INVALID_PLUGIN_INSTALL_METADATA",
          message: `Claude scoped plugin installation has an invalid project path: ${metadataFile}`,
          metadata: { host: "claude-code", name: entry.name, scope: declaredScope },
        }),
      );
      return undefined;
    }
    let canonicalProject;
    try {
      const info = await stat(projectPath);
      if (!info.isDirectory()) throw new Error("project path is not a directory");
      canonicalProject = await realpath(projectPath);
    } catch (error) {
      context.diagnostics.push(
        diagnostic({
          host: "claude-code",
          path: metadataFile,
          code: "INVALID_PLUGIN_INSTALL_METADATA",
          message: `cannot inspect Claude plugin project path ${projectPath}: ${error.message}`,
          metadata: { host: "claude-code", name: entry.name, scope: declaredScope },
        }),
      );
      return undefined;
    }
    const workspaces = await Promise.all(
      context.workspaceDirectories.map((directory) =>
        realpath(directory).catch(() => path.resolve(directory))
      ),
    );
    return workspaces.some((workspace) => isPathContained(canonicalProject, workspace))
      ? "workspace"
      : undefined;
  }

  function knownMarketplaceEntries(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const marketplaces = value.marketplaces ?? value.known_marketplaces ?? value;
    if (!marketplaces || typeof marketplaces !== "object" || Array.isArray(marketplaces)) {
      return [];
    }
    return Object.entries(marketplaces).flatMap(([name, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const installPath = entry.installLocation
        ?? entry.install_location
        ?? entry.path
        ?? entry.directory;
      return installPath
        ? [{ ...entry, name, installPath }]
        : [];
    });
  }

  async function discoverClaude(context) {
    context.host = "claude-code";
    const { home, env } = context;
    const claudeHome = path.resolve(
      stringValue(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude"),
    );
    context.claudeHome = claudeHome;
    const pluginsRoot = path.join(claudeHome, "plugins");
    const safePluginsRoot = await safeDirectory(
      pluginsRoot,
      claudeHome,
      context,
      { host: "claude-code", source: "plugins" },
    );
    if (!safePluginsRoot) {
      if (env.CLAUDE_CODE_SYNC_SKILLS === "1") {
        await addSyncedRoot({
          root: path.join(claudeHome, "skills", "synced"),
          context,
        });
      }
      return;
    }
    const cacheRoot = path.join(safePluginsRoot, "cache");
    const safeCacheRoot = await safeDirectory(
      cacheRoot,
      safePluginsRoot,
      context,
      { host: "claude-code", source: "cache" },
    );
    if (safeCacheRoot) {
      await discoverVersionedPluginCache({
        cacheRoot: safeCacheRoot,
        boundary: safeCacheRoot,
        context,
        host: "claude-code",
        scope: "global",
        manifestPolicy: CLAUDE_MANIFEST_POLICY,
      });
    }

    const marketplacesRoot = path.join(safePluginsRoot, "marketplaces");
    const safeMarketplacesRoot = await safeDirectory(
      marketplacesRoot,
      safePluginsRoot,
      context,
      { host: "claude-code", source: "marketplaces" },
    );
    if (safeMarketplacesRoot) for (const marketplace of await pluginDirectories(
      safeMarketplacesRoot,
      context,
      { host: "claude-code", source: "marketplace" },
    )) {
      await discoverMarketplaceManifests({
        base: marketplace.path,
        boundary: safeMarketplacesRoot,
        context,
        host: "claude-code",
        scope: "global",
        marketplaceName: marketplace.entry.name,
        active: false,
        manifestFiles: CLAUDE_MARKETPLACE_MANIFEST_FILES,
        marketplaceRootDirectories: [".claude-plugin"],
        manifestPolicy: CLAUDE_MANIFEST_POLICY,
      });
    }

    for (const metadataFile of await claudeInstalledMetadata({
      claudePluginsRoot: safePluginsRoot,
      context,
    })) {
      if (metadataFile.kind === "known_marketplaces.json") {
        for (const entry of knownMarketplaceEntries(metadataFile.value)) {
          const installPath = stringValue(entry.installPath);
          if (!installPath) {
            context.diagnostics.push(
              diagnostic({
                host: "claude-code",
                path: metadataFile.file,
                code: "PLUGIN_DECLARATION_INVALID_PATH",
                message: `Claude marketplace metadata has an invalid install path: ${metadataFile.file}`,
                metadata: { host: "claude-code", name: entry.name },
              }),
            );
            continue;
          }
          await discoverMarketplaceManifests({
            base: path.isAbsolute(installPath)
              ? installPath
              : path.resolve(safePluginsRoot, installPath),
            boundary: safePluginsRoot,
            context,
            host: "claude-code",
            scope: "global",
            marketplaceName: entry.name,
            active: false,
            manifestFiles: CLAUDE_MARKETPLACE_MANIFEST_FILES,
            marketplaceRootDirectories: [".claude-plugin"],
            manifestPolicy: CLAUDE_MANIFEST_POLICY,
          });
        }
      }
      for (const entry of installedEntries(metadataFile.value)) {
        const installPath = stringValue(entry.installPath ?? entry.install_path ?? entry.path);
        if (!installPath) continue;
        const scope = await claudeInstalledScope({
          entry,
          metadataFile: metadataFile.file,
          context,
        });
        if (!scope) continue;
        const installRoot = path.isAbsolute(installPath)
          ? installPath
          : path.resolve(safePluginsRoot, installPath);
        const versionedCache = safeCacheRoot
          && await canonicalContained(installRoot, safeCacheRoot);
        await addPluginInstall({
          installRoot,
          boundary: safePluginsRoot,
          host: "claude-code",
          marketplace: entry.marketplace,
          name: entry.name,
          version: entry.version,
          scope,
          source: entry,
          ...(versionedCache
            ? { cache: { kind: "versioned", scope }, active: true }
            : {}),
          declaration: entry,
          context,
          manifestPolicy: CLAUDE_MANIFEST_POLICY,
        });
      }
    }

    if (env.CLAUDE_CODE_SYNC_SKILLS === "1") {
      await addSyncedRoot({
        root: path.join(claudeHome, "skills", "synced"),
        context,
      });
    }
  }

  return Object.freeze({
    host: "claude-code",
    discover: discoverClaude,
  });
}
