import {
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";

const PLUGIN_OWNER_PREFIX = "plugin:";
const MANIFEST_FILES = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  "plugin.json",
  "manifest.json",
  "gemini-extension.json",
  "package.json",
];
const DECLARED_SKILL_DIRECTORY_FIELDS = [
  "skills",
  "skillDirectories",
  "skill_directories",
  "skillsDirectory",
  "skills_directory",
  "skillsDir",
  "skills_dir",
  "skillPath",
  "skill_path",
];

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function contains(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeIdentityPart(value, fallback = "local") {
  return (stringValue(value) ?? fallback)
    .replaceAll("%", "%25")
    .replaceAll("/", "%2F")
    .replaceAll("\\", "%5C")
    .replaceAll(":", "%3A");
}

function pluginIdentity({ host, marketplace, name }) {
  return `local:plugin:${safeIdentityPart(host)}:${safeIdentityPart(marketplace)}:${safeIdentityPart(name)}`;
}

function diagnostic({ host, path: targetPath, code, message, metadata }) {
  return {
    kind: "plugin",
    host,
    path: path.resolve(targetPath),
    code,
    message,
    ...(metadata ? { plugin: structuredClone(metadata) } : {}),
  };
}

function metadataFor({ host, marketplace, name, version, root, manifestPath, source }) {
  return {
    host,
    marketplace: stringValue(marketplace) ?? "local",
    name: stringValue(name) ?? path.basename(root),
    ...(stringValue(version) ? { version: stringValue(version) } : {}),
    ...(root ? { root: path.resolve(root) } : {}),
    ...(manifestPath ? { manifestPath: path.resolve(manifestPath) } : {}),
    ...(source ? { source } : {}),
  };
}

function repositoryValue(value, seen = new Set()) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const candidate of [value.url, value.repository, value.repositoryUrl]) {
    const repository = repositoryValue(candidate, seen);
    if (repository) return repository;
  }
  return undefined;
}

function sourceMetadata(manifest, declaration = {}) {
  const source = declaration.source && typeof declaration.source === "object"
    ? declaration.source
    : manifest?.source && typeof manifest.source === "object"
      ? manifest.source
      : {};
  const declarationSourceRepository = declaration.source && typeof declaration.source === "object"
    ? repositoryValue(declaration.source)
    : undefined;
  const manifestSourceRepository = manifest?.source && typeof manifest.source === "object"
    ? repositoryValue(manifest.source)
    : undefined;
  const repository = repositoryValue(
    declaration.repository
      ?? declaration.repository_url
      ?? declaration.repositoryUrl
      ?? declarationSourceRepository
      ?? manifest?.repository
      ?? manifest?.repository_url
      ?? manifest?.repositoryUrl
      ?? manifestSourceRepository,
  );
  const upstreamPath = normalizeUpstreamEntrypoint(
    declaration.upstream_path
      ?? declaration.upstreamPath
      ?? source.upstream_path
      ?? source.upstreamPath
      ?? manifest?.upstream_path
      ?? manifest?.upstreamPath,
  );
  return { repository, upstreamPath };
}

function pluginEvidence({ metadata, source }) {
  let repository;
  if (source.repository) {
    try {
      repository = normalizeRepositoryUrl(source.repository);
    } catch {
      repository = undefined;
    }
  }
  const evidence = {
    kind: "plugin",
    host: metadata.host,
    plugin: metadata.name,
    marketplace: metadata.marketplace,
    ...(metadata.version ? { version: metadata.version } : {}),
    identity: pluginIdentity(metadata),
    ...(repository ? { repository } : {}),
    ...(source.upstreamPath
      ? { upstream_path: source.upstreamPath, upstreamPath: source.upstreamPath }
      : {}),
    provenance: {
      kind: "plugin",
      host: metadata.host,
      plugin: metadata.name,
      marketplace: metadata.marketplace,
      ...(metadata.version ? { version: metadata.version } : {}),
      ...(repository ? { repository } : {}),
      ...(source.upstreamPath ? { upstream_path: source.upstreamPath } : {}),
    },
  };
  return { evidence, repository: Boolean(source.repository) && !repository };
}

function declaredDirectoryValues(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return [
      item.path,
      item.directory,
      item.root,
      item.skills,
    ].filter((candidate) => typeof candidate === "string");
  });
}

function declaredSkillDirectories(manifest, declaration = {}) {
  const values = [];
  for (const field of DECLARED_SKILL_DIRECTORY_FIELDS) {
    values.push(...declaredDirectoryValues(declaration[field]));
    values.push(...declaredDirectoryValues(manifest?.[field]));
  }
  const nested = [
    declaration.layout,
    manifest?.layout,
    declaration.components,
    manifest?.components,
  ];
  for (const value of nested) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const field of DECLARED_SKILL_DIRECTORY_FIELDS) {
      values.push(...declaredDirectoryValues(value[field]));
    }
  }
  return unique(values.map((value) => value.trim()).filter(Boolean));
}

async function directoryEntries(target, context, metadata, { reportMissing = false } = {}) {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  } catch (error) {
    if (error.code === "ENOENT" && !reportMissing) return [];
    if (error.code === "ENOENT") {
      context.diagnostics.push(
        diagnostic({
          host: context.host,
          path: target,
          code: "PLUGIN_ROOT_MISSING",
          message: `documented plugin root is missing: ${target}`,
          metadata,
        }),
      );
      return [];
    }
    context.diagnostics.push(
      diagnostic({
        host: context.host,
        path: target,
        code: "PLUGIN_ROOT_UNREADABLE",
        message: `cannot read documented plugin root ${target}: ${error.message}`,
        metadata,
      }),
    );
    return [];
  }
}

async function canonicalContained(target, boundary) {
  try {
    const [canonicalTarget, canonicalBoundary] = await Promise.all([
      realpath(target),
      realpath(boundary),
    ]);
    return contains(canonicalBoundary, canonicalTarget);
  } catch {
    return false;
  }
}

async function safeDirectory(target, boundary, context, metadata, { declared = false } = {}) {
  const resolvedTarget = path.resolve(target);
  const resolvedBoundary = path.resolve(boundary);
  if (!contains(resolvedBoundary, resolvedTarget)) {
    context.diagnostics.push(
      diagnostic({
        host: context.host,
        path: resolvedTarget,
        code: "PLUGIN_ROOT_ESCAPE",
        message: `plugin path escapes its declared root: ${resolvedTarget}`,
        metadata,
      }),
    );
    return undefined;
  }
  let info;
  try {
    info = await lstat(resolvedTarget);
  } catch (error) {
    if (error.code === "ENOENT" && !declared) return undefined;
    context.diagnostics.push(
      diagnostic({
        host: context.host,
        path: resolvedTarget,
        code: error.code === "ENOENT" ? "PLUGIN_SKILL_ROOT_MISSING" : "PLUGIN_ROOT_UNREADABLE",
        message: error.code === "ENOENT"
          ? `declared plugin skill root is missing: ${resolvedTarget}`
          : `cannot inspect plugin path ${resolvedTarget}: ${error.message}`,
        metadata,
      }),
    );
    return undefined;
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    context.diagnostics.push(
      diagnostic({
        host: context.host,
        path: resolvedTarget,
        code: "PLUGIN_ROOT_NOT_DIRECTORY",
        message: `plugin skill root is not a directory: ${resolvedTarget}`,
        metadata,
      }),
    );
    return undefined;
  }
  // A lexical check is not enough for cache aliases; both sides must be canonical.
  if (!(await canonicalContained(resolvedTarget, resolvedBoundary))) {
    context.diagnostics.push(
      diagnostic({
        host: context.host,
        path: resolvedTarget,
        code: "PLUGIN_ROOT_ESCAPE",
        message: `plugin path resolves outside its declared root: ${resolvedTarget}`,
        metadata,
      }),
    );
    return undefined;
  }
  return resolvedTarget;
}

async function readJsonObject(
  file,
  context,
  { host = context.host, metadata, description = "plugin metadata" } = {},
) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    context.diagnostics.push(
      diagnostic({
        host,
        path: file,
        code: "PLUGIN_METADATA_UNREADABLE",
        message: `cannot read ${description} ${file}: ${error.message}`,
        metadata,
      }),
    );
    return undefined;
  }
  try {
    const value = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("metadata must be a JSON object");
    }
    return value;
  } catch (error) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: file,
        code: "MALFORMED_PLUGIN_METADATA",
        message: `malformed ${description} ${file}: ${error.message}`,
        metadata,
      }),
    );
    return undefined;
  }
}

async function readManifest(installRoot, context, metadata) {
  for (const relative of MANIFEST_FILES) {
    const file = path.join(installRoot, relative);
    const value = await readJsonObject(file, context, {
      host: context.host,
      metadata,
    });
    if (value) return { value, path: file };
  }
  return undefined;
}

async function addPluginInstall({
  installRoot,
  boundary,
  host,
  marketplace,
  name,
  version,
  scope,
  source,
  declaration = {},
  context,
  defaultSkillDirectory = "skills",
  includeDefaultSkillDirectory = true,
}) {
  const initialMetadata = metadataFor({
    host,
    marketplace,
    name,
    version,
    root: installRoot,
  });
  const safeInstallRoot = await safeDirectory(
    installRoot,
    boundary,
    context,
    initialMetadata,
  );
  if (!safeInstallRoot) return;

  const manifest = await readManifest(safeInstallRoot, context, initialMetadata);
  const manifestValue = manifest?.value;
  const metadata = metadataFor({
    host,
    marketplace: declaration.marketplace ?? manifestValue?.marketplace ?? marketplace,
    name: declaration.name ?? manifestValue?.name ?? name,
    version: declaration.version ?? manifestValue?.version ?? version,
    root: safeInstallRoot,
    manifestPath: manifest?.path,
    source: declaration.sourceType,
  });
  const provenanceSource = sourceMetadata(manifestValue, declaration);
  const evidenceResult = pluginEvidence({ metadata, source: provenanceSource });
  if (evidenceResult.repository) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: manifest?.path ?? safeInstallRoot,
        code: "INVALID_PLUGIN_REPOSITORY",
        message: `plugin repository metadata is invalid for ${metadata.name}`,
        metadata,
      }),
    );
  }
  const directories = [
    ...(includeDefaultSkillDirectory ? [defaultSkillDirectory] : []),
    ...declaredSkillDirectories(manifestValue, declaration),
  ];
  for (const relativeDirectory of unique(directories)) {
    const value = stringValue(relativeDirectory);
    if (!value) continue;
    const skillRoot = await safeDirectory(
      path.isAbsolute(value) ? value : path.resolve(safeInstallRoot, value),
      safeInstallRoot,
      context,
      metadata,
      { declared: value !== defaultSkillDirectory },
    );
    if (!skillRoot) continue;
    const rootInfo = {
      path: skillRoot,
      owner: `${PLUGIN_OWNER_PREFIX}${host}`,
      owners: [`${PLUGIN_OWNER_PREFIX}${host}`],
      scope,
      origin: "plugin",
      host,
      plugin: {
        host: metadata.host,
        marketplace: metadata.marketplace,
        name: metadata.name,
        ...(metadata.version ? { version: metadata.version } : {}),
      },
      pluginMetadata: metadata,
      pluginIdentity: pluginIdentity(metadata),
      pluginEvidence: [evidenceResult.evidence],
      pluginRoot: safeInstallRoot,
      ...(manifest?.path ? { pluginManifest: manifest.path } : {}),
    };
    context.roots.push(rootInfo);
  }
}

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

async function pluginDirectories(root, context, metadata, filter = () => true) {
  const entries = await directoryEntries(root, context, metadata);
  const result = [];
  for (const entry of entries) {
    if (!filter(entry)) continue;
    const candidate = await safeDirectory(
      path.join(root, entry.name),
      root,
      context,
      metadata,
    );
    if (candidate) result.push({ entry, path: candidate });
  }
  return result;
}

async function discoverVersionedPluginCache({
  cacheRoot,
  boundary,
  context,
  host,
  scope,
}) {
  const cacheMetadata = { host, source: "cache" };
  for (const marketplace of await pluginDirectories(cacheRoot, context, cacheMetadata)) {
    for (const plugin of await pluginDirectories(
      marketplace.path,
      context,
      { ...cacheMetadata, marketplace: marketplace.entry.name },
    )) {
      for (const version of await pluginDirectories(
        plugin.path,
        context,
        {
          ...cacheMetadata,
          marketplace: marketplace.entry.name,
          name: plugin.entry.name,
        },
      )) {
        await addPluginInstall({
          installRoot: version.path,
          boundary,
          host,
          marketplace: marketplace.entry.name,
          name: plugin.entry.name,
          version: version.entry.name,
          scope,
          source: {},
          context,
        });
      }
    }
  }
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

function marketplaceEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const plugins = value.plugins ?? value.extensions ?? value.entries;
  if (Array.isArray(plugins)) return plugins;
  if (!plugins || typeof plugins !== "object") return [];
  return Object.entries(plugins).map(([name, entry]) =>
    typeof entry === "string" ? { name, path: entry } : { name, ...entry },
  );
}

async function discoverClaude(context) {
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
        });
      }
    }
    for (const entry of installedEntries(metadataFile.value)) {
      const installPath = stringValue(entry.installPath ?? entry.install_path ?? entry.path);
      if (!installPath) continue;
      await addPluginInstall({
        installRoot: path.isAbsolute(installPath)
          ? installPath
          : path.resolve(safePluginsRoot, installPath),
        boundary: safePluginsRoot,
        host: "claude-code",
        marketplace: entry.marketplace,
        name: entry.name,
        version: entry.version,
        scope: "global",
        source: entry,
        declaration: entry,
        context,
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

async function discoverCodex(context) {
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
  if (!safePluginsRoot) return;
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
      context,
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
    });
  }
  for (const workspace of context.workspaceDirectories) {
    await discoverMarketplaceManifests({
      base: path.join(workspace, ".agents", "plugins"),
      boundary: path.join(workspace, ".agents"),
      context,
      host: "codex",
      scope: "workspace",
    });
  }
}

async function discoverDirectExtensionRoots({
  root,
  boundary = root,
  host,
  scope,
  context,
  marketplace = "local",
}) {
  const safeRoot = await safeDirectory(
    root,
    boundary,
    context,
    { host, source: "extension" },
  );
  if (!safeRoot) return;
  for (const extension of await pluginDirectories(
    safeRoot,
    context,
    { host, source: "extension" },
  )) {
    await addPluginInstall({
      installRoot: extension.path,
      boundary: safeRoot,
      host,
      marketplace,
      name: extension.entry.name,
      scope,
      source: {},
      context,
    });
  }
}

async function discoverGemini(context) {
  const { home, env } = context;
  const geminiHome = path.resolve(
    stringValue(env.GEMINI_CLI_HOME) ?? path.join(home, ".gemini"),
  );
  await discoverDirectExtensionRoots({
    root: path.join(geminiHome, "extensions"),
    boundary: geminiHome,
    host: "gemini-cli",
    scope: "global",
    context,
  });
}

async function discoverCursor(context) {
  const { home, env } = context;
  const cursorHome = path.resolve(
    stringValue(env.CURSOR_HOME) ?? path.join(home, ".cursor"),
  );
  const globalRoot = path.join(cursorHome, "plugins", "local");
  await discoverDirectExtensionRoots({
    root: globalRoot,
    boundary: cursorHome,
    host: "cursor",
    scope: "global",
    context,
  });
  await discoverMarketplaceManifests({
    base: globalRoot,
    boundary: cursorHome,
    context,
    host: "cursor",
    scope: "global",
    marketplaceName: "local",
  });
  for (const workspace of context.workspaceDirectories) {
    const workspaceRoot = path.join(workspace, ".cursor", "plugins", "local");
    await discoverDirectExtensionRoots({
      root: workspaceRoot,
      boundary: workspace,
      host: "cursor",
      scope: "workspace",
      context,
    });
    await discoverMarketplaceManifests({
      base: workspaceRoot,
      boundary: workspace,
      context,
      host: "cursor",
      scope: "workspace",
      marketplaceName: "local",
    });
  }
}

async function readMarketplaceManifest(file, context, host) {
  return readJsonObject(file, context, {
    host,
    description: "marketplace metadata",
  });
}

async function discoverMarketplaceManifests({
  base,
  boundary,
  context,
  host,
  scope,
  marketplaceName,
}) {
  const safeBase = await safeDirectory(
    base,
    boundary,
    context,
    { host, source: "marketplace" },
  );
  if (!safeBase) return;
  const manifestFiles = [
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    "marketplace.json",
    "plugins.json",
    "manifest.json",
  ].map((file) => path.join(safeBase, file));
  for (const file of unique(manifestFiles)) {
    const manifest = await readMarketplaceManifest(file, context, host);
    if (!manifest) continue;
    const marketplace = stringValue(manifest.name) ?? marketplaceName ?? path.basename(safeBase);
    for (const entry of marketplaceEntries(manifest)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const source = entry.source;
      const sourcePath = typeof source === "string"
        ? source
        : source && typeof source === "object"
          ? source.path ?? source.directory ?? source.root
          : undefined;
      const configuredPathValue = entry.path
        ?? entry.directory
        ?? entry.root
        ?? entry.installPath
        ?? sourcePath;
      const configuredPath = stringValue(configuredPathValue);
      if (!configuredPath) {
        context.diagnostics.push(
          diagnostic({
            host,
            path: file,
            code: configuredPathValue === undefined
              ? "PLUGIN_DECLARATION_MISSING_PATH"
              : "PLUGIN_DECLARATION_INVALID_PATH",
            message: configuredPathValue === undefined
              ? `marketplace plugin declaration has no local path: ${file}`
              : `marketplace plugin declaration has an invalid local path: ${file}`,
            metadata: { host, marketplace, name: entry.name },
          }),
        );
        continue;
      }
      const declarationBase = [".claude-plugin", ".cursor-plugin"].includes(
        path.basename(path.dirname(file)),
      )
        ? path.dirname(path.dirname(file))
        : path.dirname(file);
      await addPluginInstall({
        installRoot: path.isAbsolute(configuredPath)
          ? configuredPath
          : path.resolve(declarationBase, configuredPath),
        boundary: boundary ?? safeBase,
        host,
        marketplace,
        name: entry.name,
        version: entry.version,
        scope,
        source: entry,
        declaration: {
          ...entry,
          sourceType: "marketplace",
          marketplace,
        },
        context,
      });
    }
  }
}

function normalizeWorkspaceDirectories({ cwd, home, workspaceDirectories }) {
  return unique(
    (workspaceDirectories ?? boundedWorkspaceDirectories({ cwd, home }))
      .map((directory) => typeof directory === "string" ? directory : directory.path)
      .filter(Boolean)
      .map((directory) => path.resolve(directory)),
  );
}

// Host adapters own documented locations; callers and candidate grouping stay host-agnostic.
export const PLUGIN_HOST_SPECIFICATIONS = Object.freeze([
  Object.freeze({ host: "claude-code", discover: discoverClaude }),
  Object.freeze({ host: "codex", discover: discoverCodex }),
  Object.freeze({ host: "gemini-cli", discover: discoverGemini }),
  Object.freeze({ host: "cursor", discover: discoverCursor }),
]);

export async function discoverPluginSkillRoots({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
  workspaceDirectories,
  hostSpecifications = PLUGIN_HOST_SPECIFICATIONS,
} = {}) {
  const context = {
    home: path.resolve(home),
    cwd: path.resolve(cwd),
    env,
    workspaceDirectories: normalizeWorkspaceDirectories({
      cwd,
      home,
      workspaceDirectories,
    }),
    roots: [],
    diagnostics: [],
  };
  for (const specification of hostSpecifications) {
    if (!specification || typeof specification.discover !== "function") continue;
    context.host = specification.host ?? "unknown";
    try {
      await specification.discover(context);
    } catch (error) {
      context.diagnostics.push(
        diagnostic({
          host: context.host,
          path: context.cwd,
          code: "PLUGIN_HOST_DISCOVERY_FAILED",
          message: `plugin discovery failed for ${context.host}: ${error.message}`,
        }),
      );
    }
  }
  const roots = [];
  const byPath = new Map();
  for (const item of context.roots) {
    const key = `${path.resolve(item.path)}\0${item.pluginIdentity ?? ""}`;
    const existing = byPath.get(key);
    if (!existing) {
      const normalized = {
        ...item,
        path: path.resolve(item.path),
        owners: unique(item.owners ?? [item.owner]),
        pluginEvidence: unique(
          (item.pluginEvidence ?? []).map((value) => JSON.stringify(value)),
        ).map((value) => JSON.parse(value)),
      };
      byPath.set(key, normalized);
      roots.push(normalized);
      continue;
    }
    existing.owners = unique([...existing.owners, ...(item.owners ?? [])]);
    existing.pluginEvidence = unique([
      ...existing.pluginEvidence.map((value) => JSON.stringify(value)),
      ...(item.pluginEvidence ?? []).map((value) => JSON.stringify(value)),
    ]).map((value) => JSON.parse(value));
  }
  roots.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    roots,
    diagnostics: context.diagnostics,
  };
}
