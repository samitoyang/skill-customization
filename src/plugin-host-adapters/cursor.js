import path from "node:path";

import { createPluginHostAdapter } from "./interface.js";
import {
  GENERIC_MARKETPLACE_MANIFEST_FILES,
  stringValue,
} from "./metadata.js";

const CURSOR_MANIFEST_POLICY = Object.freeze({
  files: Object.freeze([".cursor-plugin/plugin.json", "plugin.json"]),
  description: "Cursor plugin metadata",
  requiredFields: Object.freeze(["name"]),
  skipInvalidExtension: true,
  manifestOverridesDeclaration: true,
  declaredSkillDirectoriesReplaceDefault: true,
  includeRootSkillFallback: true,
  includeDefaultSkillRoot: false,
  manifestNamePattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
});

const CURSOR_MARKETPLACE_MANIFEST_FILES = Object.freeze([
  ".cursor-plugin/marketplace.json",
  ...GENERIC_MARKETPLACE_MANIFEST_FILES,
]);
const CURSOR_MARKETPLACE_ROOT_DIRECTORIES = Object.freeze([".cursor-plugin"]);
const CURSOR_MARKETPLACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function invalidMarketplaceResult(pluginRoot) {
  return {
    valid: false,
    entries: [],
    ...(pluginRoot ? { pluginRoot } : {}),
  };
}

function createCursorMarketplacePolicy({ diagnostic }) {
  return Object.freeze({
    validate({ manifest, file, host, marketplace, context }) {
      let valid = true;
      if (
        typeof manifest.name !== "string"
        || !CURSOR_MARKETPLACE_NAME_PATTERN.test(manifest.name)
      ) {
        valid = false;
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_INVALID_NAME",
            message: `Cursor marketplace name is invalid: ${file}`,
            metadata: { host, marketplace },
          }),
        );
      }
      const owner = manifest.owner;
      if (
        !owner
        || typeof owner !== "object"
        || Array.isArray(owner)
        || typeof owner.name !== "string"
        || !owner.name.trim()
      ) {
        valid = false;
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_INVALID_OWNER",
            message: `Cursor marketplace owner is invalid: ${file}`,
            metadata: { host, marketplace },
          }),
        );
      }

      const pluginRoot = manifest.metadata?.pluginRoot;
      const normalizedPluginRoot = stringValue(pluginRoot);
      if (
        Object.hasOwn(manifest.metadata ?? {}, "pluginRoot")
        && !normalizedPluginRoot
      ) {
        valid = false;
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_INVALID_ROOT",
            message: `marketplace pluginRoot must be a non-empty string: ${file}`,
            metadata: { host, marketplace },
          }),
        );
      }

      if (!Object.hasOwn(manifest, "plugins")) {
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_MISSING_ENTRIES",
            message: `marketplace metadata has no plugin entries: ${file}`,
            metadata: { host, marketplace },
          }),
        );
        return invalidMarketplaceResult(normalizedPluginRoot);
      }
      if (!Array.isArray(manifest.plugins)) {
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_INVALID_ENTRIES",
            message: `marketplace plugin entries must be an array or object: ${file}`,
            metadata: { host, marketplace },
          }),
        );
        return invalidMarketplaceResult(normalizedPluginRoot);
      }
      if (manifest.plugins.length > 500) {
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: "PLUGIN_MARKETPLACE_TOO_MANY_ENTRIES",
            message: `Cursor marketplace has more than 500 plugins: ${file}`,
            metadata: { host, marketplace },
          }),
        );
        return invalidMarketplaceResult(normalizedPluginRoot);
      }
      return {
        valid,
        entries: manifest.plugins,
        ...(normalizedPluginRoot ? { pluginRoot: normalizedPluginRoot } : {}),
      };
    },

    validateEntry({ entry, file, context, marketplace }) {
      if (
        typeof entry.name !== "string"
        || !CURSOR_MARKETPLACE_NAME_PATTERN.test(entry.name)
      ) {
        context.diagnostics.push(
          diagnostic({
            host: "cursor",
            path: file,
            code: "PLUGIN_DECLARATION_INVALID_NAME",
            message: `Cursor marketplace plugin name is invalid: ${file}`,
            metadata: { host: "cursor", marketplace, name: entry.name },
          }),
        );
        return false;
      }
      return true;
    },
  });
}

async function cursorMarketplaceManifestStatus({ root, lstat, canonicalContained }) {
  const file = path.join(root, ".cursor-plugin", "marketplace.json");
  try {
    await lstat(file);
    return {
      present: true,
      contained: await canonicalContained(file, root),
    };
  } catch {
    return { present: false, contained: false };
  }
}

/**
 * Create the Cursor host adapter from shared plugin observation primitives.
 * The adapter owns Cursor locations, metadata rules, marketplace validation,
 * activation policy, fallback behavior, and diagnostics; injected functions
 * emit normalized observations and enforce reusable containment.
 *
 * @param {import("./interface.js").CursorAdapterToolkit} toolkit
 * @returns {import("./interface.js").PluginHostAdapter}
 */
export function createCursorAdapter({
  addPluginInstall,
  canonicalContained,
  diagnostic,
  discoverMarketplaceManifests,
  lstat,
  pluginDirectories,
  pluginIdentity,
  realpath,
  safeDirectory,
}) {
  const marketplacePolicy = createCursorMarketplacePolicy({ diagnostic });

  function marketplaceOptions({ base, boundary, context, scope, marketplaceName, ownedRoots }) {
    return {
      base,
      boundary,
      context,
      host: "cursor",
      scope,
      marketplaceName,
      active: true,
      manifestFiles: CURSOR_MARKETPLACE_MANIFEST_FILES,
      marketplaceRootDirectories: CURSOR_MARKETPLACE_ROOT_DIRECTORIES,
      manifestPolicy: CURSOR_MANIFEST_POLICY,
      marketplacePolicy,
      localPluginIdentity: pluginIdentity,
      onDeclaredPlugin: async ({ location }) => {
        if (!(await canonicalContained(location.installRoot, location.boundary))) return false;
        const canonicalRoot = await realpath(location.installRoot).catch(() => undefined);
        if (canonicalRoot) ownedRoots.add(canonicalRoot);
        return true;
      },
    };
  }

  async function discoverCursorLocalPluginRoots({
    root,
    boundary,
    scope,
    context,
    ownedRoots,
  }) {
    const safeRoot = await safeDirectory(
      root,
      boundary,
      context,
      { host: "cursor", source: "extension" },
    );
    if (!safeRoot) return;
    for (const extension of await pluginDirectories(
      safeRoot,
      context,
      { host: "cursor", source: "extension" },
    )) {
      const canonicalExtension = await realpath(extension.path).catch(() => undefined);
      if (canonicalExtension && ownedRoots.has(canonicalExtension)) continue;
      const marketplaceManifest = await cursorMarketplaceManifestStatus({
        root: extension.path,
        lstat,
        canonicalContained,
      });
      if (marketplaceManifest.present) {
        const discoveredMarketplace = await discoverMarketplaceManifests(
          marketplaceOptions({
            base: extension.path,
            boundary: safeRoot,
            context,
            scope,
            marketplaceName: "local",
            ownedRoots,
          }),
        );
        if (marketplaceManifest.contained && discoveredMarketplace) continue;
      }
      await addPluginInstall({
        installRoot: extension.path,
        boundary: safeRoot,
        host: "cursor",
        marketplace: "local",
        name: extension.entry.name,
        scope,
        source: {},
        active: true,
        context,
        manifestPolicy: CURSOR_MANIFEST_POLICY,
        localPluginIdentity: pluginIdentity,
      });
    }
  }

  async function discoverCursor(context) {
    context.host = "cursor";
    const cursorHome = path.resolve(
      stringValue(context.env.CURSOR_HOME) ?? path.join(context.home, ".cursor"),
    );
    const ownedRoots = new Set();
    const globalRoot = path.join(cursorHome, "plugins", "local");
    await discoverMarketplaceManifests(marketplaceOptions({
      base: globalRoot,
      boundary: cursorHome,
      context,
      scope: "global",
      marketplaceName: "local",
      ownedRoots,
    }));
    await discoverCursorLocalPluginRoots({
      root: globalRoot,
      boundary: cursorHome,
      scope: "global",
      context,
      ownedRoots,
    });
    for (const workspace of context.workspaceDirectories) {
      const workspaceRoot = path.join(workspace, ".cursor", "plugins", "local");
      await discoverMarketplaceManifests(marketplaceOptions({
        base: workspaceRoot,
        boundary: workspace,
        context,
        scope: "workspace",
        marketplaceName: "local",
        ownedRoots,
      }));
      await discoverCursorLocalPluginRoots({
        root: workspaceRoot,
        boundary: workspace,
        scope: "workspace",
        context,
        ownedRoots,
      });
    }
  }

  return createPluginHostAdapter("cursor", discoverCursor);
}
