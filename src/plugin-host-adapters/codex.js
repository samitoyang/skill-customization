import path from "node:path";

import { pluginHostResult } from "./interface.js";
import {
  GENERIC_MANIFEST_FILES,
  GENERIC_MARKETPLACE_MANIFEST_FILES,
  safeIdentityPart,
  stringValue,
} from "./metadata.js";

const CODEX_MANIFEST_POLICY = Object.freeze({
  files: [".codex-plugin/plugin.json", ...GENERIC_MANIFEST_FILES],
});
const CODEX_MARKETPLACE_MANIFEST_FILES = Object.freeze([
  ...GENERIC_MARKETPLACE_MANIFEST_FILES,
]);

function codexPluginIdentity({ host, marketplace, name }) {
  return `local:plugin:${safeIdentityPart(host)}:${safeIdentityPart(marketplace)}:${safeIdentityPart(name)}`;
}

function tomlQuotedValue(quote, value) {
  if (quote === "'") return value;
  return tomlBasicStringValue(value);
}

function tomlKeyValue(doubleQuoted, singleQuoted, bare) {
  return stringValue(
    doubleQuoted !== undefined
      ? tomlQuotedValue('"', doubleQuoted)
      : singleQuoted !== undefined
        ? tomlQuotedValue("'", singleQuoted)
        : bare,
  );
}

function tomlAssignmentKey(line) {
  const match = line.match(
    /^(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=/,
  );
  return match ? tomlKeyValue(match[1], match[2], match[3]) : undefined;
}

function tomlDottedMarketplaceAssignment(line) {
  const match = line.match(
    /^(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\.\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\.\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*/,
  );
  if (!match || tomlKeyValue(match[1], match[2], match[3]) !== "marketplaces") {
    return undefined;
  }
  const key = tomlKeyValue(match[7], match[8], match[9]);
  if (key !== "source" && key !== "source_type") return undefined;
  return {
    name: tomlKeyValue(match[4], match[5], match[6]),
    key,
    value: line.slice(match[0].length),
  };
}

function tomlSinglelineStringValue(value) {
  const match = value.match(
    /^(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/,
  );
  if (!match) return undefined;
  return {
    value: tomlQuotedValue(
      match[1] !== undefined ? '"' : "'",
      match[1] ?? match[2],
    ),
  };
}

function tomlBasicStringValue(value) {
  let result = "";
  const escapes = new Map([
    ["b", "\b"],
    ["t", "\t"],
    ["n", "\n"],
    ["f", "\f"],
    ["r", "\r"],
    ['"', '"'],
    ["\\", "\\"],
  ]);
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === "\n" || escaped === "\r") {
      index += escaped === "\r" && value[index + 2] === "\n" ? 2 : 1;
      while ([" ", "\t", "\n", "\r"].includes(value[index + 1])) index += 1;
      continue;
    }
    if (escapes.has(escaped)) {
      result += escapes.get(escaped);
      index += 1;
      continue;
    }
    const digits = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
    const hexadecimal = digits > 0 ? value.slice(index + 2, index + 2 + digits) : "";
    if (
      !digits
      || hexadecimal.length !== digits
      || !/^[0-9A-Fa-f]+$/.test(hexadecimal)
    ) {
      return undefined;
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return undefined;
    }
    result += String.fromCodePoint(codePoint);
    index += digits + 1;
  }
  return result;
}

function tomlMultilineDelimiterIndex(value, delimiter, literal) {
  let from = 0;
  while (from < value.length) {
    const found = value.indexOf(delimiter, from);
    if (found < 0 || literal) return found;
    let backslashes = 0;
    for (let index = found - 1; index >= 0 && value[index] === "\\"; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return found;
    from = found + delimiter.length;
  }
  return -1;
}

function tomlMultilineValue(lines, start, assignmentValue) {
  const delimiter = assignmentValue.startsWith('"""')
    ? '"""'
    : assignmentValue.startsWith("'''")
      ? "'''"
      : undefined;
  if (!delimiter) return undefined;
  const literal = delimiter === "'''";
  const pieces = [];
  let line = start;
  let fragment = assignmentValue.slice(delimiter.length);
  while (line < lines.length) {
    const closing = tomlMultilineDelimiterIndex(fragment, delimiter, literal);
    if (closing >= 0) {
      const trailing = fragment.slice(closing + delimiter.length).trim();
      if (trailing && !trailing.startsWith("#")) return undefined;
      pieces.push(fragment.slice(0, closing));
      let value = pieces.join("\n");
      if (pieces.length > 1 && pieces[0] === "") value = value.slice(1);
      return {
        value: literal ? value : tomlBasicStringValue(value),
        end: line,
      };
    }
    pieces.push(fragment);
    line += 1;
    fragment = lines[line] ?? "";
  }
  return undefined;
}

function codexMarketplaceConfigEntries(contents) {
  const entries = [];
  const entriesByName = new Map();
  const invalid = [];
  const lines = contents.split(/\r?\n/);
  let current;
  let topLevel = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(
      /^\[\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\.\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/,
    );
    if (section && tomlKeyValue(section[1], section[2], section[3]) === "marketplaces") {
      topLevel = false;
      const name = tomlKeyValue(section[4], section[5], section[6]);
      current = entriesByName.get(name);
      if (!current) {
        current = { name };
        entriesByName.set(name, current);
        entries.push(current);
      }
      continue;
    }
    if (trimmed.startsWith("[")) {
      topLevel = false;
      if (trimmed.startsWith("[marketplaces")) {
        invalid.push(index + 1);
      }
      current = undefined;
      continue;
    }
    const dotted = topLevel
      ? tomlDottedMarketplaceAssignment(trimmed)
      : undefined;
    if (dotted) {
      let entry = entriesByName.get(dotted.name);
      if (!entry) {
        entry = { name: dotted.name };
        entriesByName.set(dotted.name, entry);
        entries.push(entry);
      }
      const singleline = tomlSinglelineStringValue(dotted.value);
      const multiline = singleline
        ? undefined
        : tomlMultilineValue(lines, index, dotted.value);
      const parsed = singleline ?? multiline;
      if (parsed?.value !== undefined) entry[dotted.key] = parsed.value;
      else invalid.push(index + 1);
      if (multiline) index = multiline.end;
      continue;
    }
    if (!current) continue;
    const assignment = trimmed.match(
      /^(?:"((?:\\.|[^"])*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/,
    );
    if (!assignment) {
      const key = tomlAssignmentKey(trimmed);
      const assignmentValue = trimmed.slice(trimmed.indexOf("=") + 1).trimStart();
      const multiline = key
        ? tomlMultilineValue(lines, index, assignmentValue)
        : undefined;
      if (multiline) {
        if (
          multiline.value !== undefined
          && (key === "source" || key === "source_type")
        ) current[key] = multiline.value;
        else if (key === "source" || key === "source_type") invalid.push(index + 1);
        index = multiline.end;
      } else if (key === "source" || key === "source_type") {
        invalid.push(index + 1);
      }
      continue;
    }
    const key = tomlKeyValue(assignment[1], assignment[2], assignment[3]);
    if (key !== "source" && key !== "source_type") continue;
    current[key] = tomlQuotedValue(
      assignment[4] !== undefined ? '"' : "'",
      assignment[4] ?? assignment[5],
    );
  }
  return { entries, invalid };
}

/** @typedef {import("./interface.js").PluginHostDiscoveryContext} CodexAdapterContext */

/**
 * Create the Codex host adapter from shared plugin observation primitives.
 * The adapter owns Codex locations, configuration interpretation, activation
 * policy, and diagnostics; injected functions emit host-independent records.
 *
 * @param {import("./interface.js").CodexAdapterToolkit} toolkit
 * @returns {import("./interface.js").PluginHostAdapter}
 */
export function createCodexAdapter({
  addPluginInstall,
  diagnostic,
  discoverMarketplaceManifests,
  discoverVersionedPluginCache,
  pluginDirectories,
  readFile,
  safeDirectory,
}) {
  async function codexMarketplaceDeclarations(codexHome, context) {
    const file = path.join(codexHome, "config.toml");
    // The marketplace declaration is control-plane input, including when it
    // is absent or malformed.  Register it before reading so Binding can
    // compare that decision input in its publication token.
    context.controlPaths?.add(path.resolve(file));
    let contents;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      context.diagnostics.push(
        diagnostic({
          host: "codex",
          path: file,
          code: "PLUGIN_METADATA_UNREADABLE",
          message: `cannot read Codex configuration ${file}: ${error.message}`,
        }),
      );
      return [];
    }

    const parsed = codexMarketplaceConfigEntries(contents);
    for (const line of parsed.invalid) {
      context.diagnostics.push(
        diagnostic({
          host: "codex",
          path: file,
          code: "MALFORMED_PLUGIN_CONFIGURATION",
          message: `malformed Codex marketplace configuration at ${file}:${line}`,
        }),
      );
    }

    const declarations = [];
    for (const entry of parsed.entries) {
      if (entry.source_type !== "local") continue;
      const source = stringValue(entry.source);
      if (!source) {
        context.diagnostics.push(
          diagnostic({
            host: "codex",
            path: file,
            code: "PLUGIN_DECLARATION_MISSING_PATH",
            message: `Codex local marketplace declaration has no source: ${file}`,
            metadata: { host: "codex", marketplace: entry.name },
          }),
        );
        continue;
      }
      declarations.push({ marketplace: entry.name, source });
    }
    return declarations;
  }

  async function discoverCodex(context) {
    context.host = "codex";
    const { home, env } = context;
    const codexHome = path.resolve(
      stringValue(env.CODEX_HOME) ?? path.join(home, ".codex"),
    );
    const pluginsRoot = path.join(codexHome, "plugins");
    const safePluginsRoot = await safeDirectory(
      pluginsRoot,
      codexHome,
      context,
      { host: "codex", source: "plugins" },
    );
    if (safePluginsRoot) {
      for (const plugin of await pluginDirectories(
        safePluginsRoot,
        context,
        { host: "codex", source: "plugin" },
        (entry) => entry.name !== "cache",
      )) {
        await addPluginInstall({
          installRoot: plugin.path,
          boundary: safePluginsRoot,
          host: "codex",
          marketplace: "local",
          name: plugin.entry.name,
          scope: "global",
          source: {},
          active: true,
          context,
          manifestPolicy: CODEX_MANIFEST_POLICY,
          localPluginIdentity: codexPluginIdentity,
        });
      }
      const cacheRoot = path.join(safePluginsRoot, "cache");
      const safeCacheRoot = await safeDirectory(
        cacheRoot,
        safePluginsRoot,
        context,
        { host: "codex", source: "cache" },
      );
      if (safeCacheRoot) {
        await discoverVersionedPluginCache({
          cacheRoot: safeCacheRoot,
          boundary: safeCacheRoot,
          context,
          host: "codex",
          scope: "global",
          active: false,
          manifestPolicy: CODEX_MANIFEST_POLICY,
          localPluginIdentity: codexPluginIdentity,
        });
      }
    }
    await discoverMarketplaceManifests({
      base: path.join(home, ".agents", "plugins"),
      boundary: home,
      context,
      host: "codex",
      scope: "global",
      marketplaceName: "personal",
      active: false,
      manifestFiles: CODEX_MARKETPLACE_MANIFEST_FILES,
      manifestPolicy: CODEX_MANIFEST_POLICY,
      localPluginIdentity: codexPluginIdentity,
    });
    const safeCodexTmpRoot = await safeDirectory(
      path.join(codexHome, ".tmp"),
      codexHome,
      context,
      { host: "codex", source: "tmp" },
    );
    if (safeCodexTmpRoot) {
      const syncedMarketplaceRoot = await safeDirectory(
        path.join(safeCodexTmpRoot, "plugins"),
        safeCodexTmpRoot,
        context,
        { host: "codex", source: "synced-marketplace" },
      );
      if (syncedMarketplaceRoot) {
        await discoverMarketplaceManifests({
          base: path.join(syncedMarketplaceRoot, ".agents", "plugins"),
          boundary: syncedMarketplaceRoot,
          context,
          host: "codex",
          scope: "global",
          active: false,
          manifestFiles: CODEX_MARKETPLACE_MANIFEST_FILES,
          manifestPolicy: CODEX_MANIFEST_POLICY,
          localPluginIdentity: codexPluginIdentity,
        });
      }
      const bundledMarketplacesRoot = await safeDirectory(
        path.join(safeCodexTmpRoot, "bundled-marketplaces"),
        safeCodexTmpRoot,
        context,
        { host: "codex", source: "bundled-marketplaces" },
      );
      for (const marketplace of bundledMarketplacesRoot
        ? await pluginDirectories(
          bundledMarketplacesRoot,
          context,
          { host: "codex", source: "bundled-marketplace" },
        )
        : []) {
        await discoverMarketplaceManifests({
          base: path.join(marketplace.path, ".agents", "plugins"),
          boundary: marketplace.path,
          context,
          host: "codex",
          scope: "global",
          marketplaceName: marketplace.entry.name,
          active: false,
          manifestFiles: CODEX_MARKETPLACE_MANIFEST_FILES,
          manifestPolicy: CODEX_MANIFEST_POLICY,
          localPluginIdentity: codexPluginIdentity,
        });
      }
    }
    for (const workspace of context.workspaceDirectories) {
      await discoverMarketplaceManifests({
        base: path.join(workspace, ".agents", "plugins"),
        boundary: workspace,
        context,
        host: "codex",
        scope: "workspace",
        active: false,
        manifestFiles: CODEX_MARKETPLACE_MANIFEST_FILES,
        manifestPolicy: CODEX_MANIFEST_POLICY,
        localPluginIdentity: codexPluginIdentity,
      });
    }
    // Configured local marketplaces are explicit roots; only their declared plugin trees are searched.
    for (const declaration of await codexMarketplaceDeclarations(codexHome, context)) {
      const configuredSource = declaration.source === "~"
        ? home
        : declaration.source.startsWith("~/")
          ? path.join(home, declaration.source.slice(2))
          : path.isAbsolute(declaration.source)
            ? declaration.source
            : path.resolve(codexHome, declaration.source);
      const configuredRoot = await safeDirectory(
        configuredSource,
        configuredSource,
        context,
        {
          host: "codex",
          source: "configured-marketplace",
          marketplace: declaration.marketplace,
        },
        { declared: true },
      );
      if (!configuredRoot) continue;
      await discoverMarketplaceManifests({
        base: path.join(configuredRoot, ".agents", "plugins"),
        boundary: configuredRoot,
        context,
        host: "codex",
        scope: "global",
        marketplaceName: declaration.marketplace,
        active: false,
        manifestFiles: CODEX_MARKETPLACE_MANIFEST_FILES,
        manifestPolicy: CODEX_MANIFEST_POLICY,
        localPluginIdentity: codexPluginIdentity,
      });
    }
  }

  return Object.freeze({
    host: "codex",
    discover: async (context) => {
      await discoverCodex(context);
      return pluginHostResult(context);
    },
  });
}
