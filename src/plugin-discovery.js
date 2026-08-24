import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";
import { isPathContained } from "./paths.js";
import { createClaudeCodeAdapter } from "./plugin-host-adapters/claude-code.js";
import { createCodexAdapter } from "./plugin-host-adapters/codex.js";
import { createCursorAdapter } from "./plugin-host-adapters/cursor.js";
import { createGeminiCliAdapter } from "./plugin-host-adapters/gemini-cli.js";
import {
  immutablePluginHostRecord,
  isPluginHostResult,
} from "./plugin-host-adapters/interface.js";
import {
  GENERIC_MANIFEST_FILES,
  GENERIC_MARKETPLACE_MANIFEST_FILES,
  safeIdentityPart,
  stringValue,
} from "./plugin-host-adapters/metadata.js";
import { publishDiscoveryPerformanceMetric } from "./performance-diagnostics.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";

const PLUGIN_OWNER_PREFIX = "plugin:";

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

function sourceMetadata(
  manifest,
  declaration = {},
  installationMetadata = {},
  { manifestOverridesDeclaration = false } = {},
) {
  const containers = manifestOverridesDeclaration
    ? [manifest, declaration]
    : [declaration, manifest];
  const firstDefined = (values) => values.find((value) => value !== undefined && value !== null);
  const repository = repositoryValue(firstDefined(containers.flatMap((container) => {
    const sourceValue = container?.source;
    const sourceRepository = sourceValue
      && typeof sourceValue === "object"
      && !Array.isArray(sourceValue)
      ? repositoryValue(sourceValue)
      : undefined;
    return [
      container?.repository,
      container?.repository_url,
      container?.repositoryUrl,
      sourceRepository,
    ];
  })));
  const installationRepository = ["git", "github-release"].includes(installationMetadata.type)
    ? installationMetadata.source
    : undefined;
  const repositoryWithInstallation = repository ?? repositoryValue(installationRepository);
  const installation = stringValue(installationMetadata.type) && stringValue(installationMetadata.source)
    ? {
      type: stringValue(installationMetadata.type),
      source: stringValue(installationMetadata.source),
    }
    : undefined;
  const upstreamPath = normalizeUpstreamEntrypoint(
    firstDefined(containers.flatMap((container) => [
      container?.upstream_path,
      container?.upstreamPath,
      container?.source && typeof container.source === "object" && !Array.isArray(container.source)
        ? container.source.upstream_path
        : undefined,
      container?.source && typeof container.source === "object" && !Array.isArray(container.source)
        ? container.source.upstreamPath
        : undefined,
    ])),
  );
  return { repository: repositoryWithInstallation, upstreamPath, installation };
}

function pluginEvidence({ metadata, source, localPluginIdentity = pluginIdentity }) {
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
    identity: localPluginIdentity(metadata),
    ...(repository ? { repository } : {}),
    ...(source.upstreamPath
      ? { upstream_path: source.upstreamPath, upstreamPath: source.upstreamPath }
      : {}),
    ...(source.installation ? { installation: source.installation } : {}),
    provenance: {
      kind: "plugin",
      host: metadata.host,
      plugin: metadata.name,
      marketplace: metadata.marketplace,
      ...(metadata.version ? { version: metadata.version } : {}),
      ...(repository ? { repository } : {}),
      ...(source.upstreamPath ? { upstream_path: source.upstreamPath } : {}),
      ...(source.installation ? { installation: source.installation } : {}),
    },
  };
  return { evidence, repository: Boolean(source.repository) && !repository };
}

function declaredDirectoryItemValues(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  return [item.path, item.directory, item.root, item.skills]
    .filter((candidate) => typeof candidate === "string");
}

function declaredDirectoryValues(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    return declaredDirectoryItemValues(item);
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

function hasDeclaredSkillDirectoryField(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [value, value.layout, value.components].some((container) =>
    container
    && typeof container === "object"
    && !Array.isArray(container)
    && DECLARED_SKILL_DIRECTORY_FIELDS.some((field) =>
      Object.hasOwn(container, field),
    ),
  );
}

function effectiveDeclaredSkillDirectories(
  manifest,
  declaration,
  { manifestOverridesDeclaration = false } = {},
) {
  if (!manifestOverridesDeclaration) return declaredSkillDirectories(manifest, declaration);
  if (hasDeclaredSkillDirectoryField(manifest)) return declaredSkillDirectories(manifest);
  return declaredSkillDirectories({}, declaration);
}

function declaredDirectoryValueIsValid(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (typeof item === "string") return Boolean(item.trim());
    return declaredDirectoryItemValues(item).some((candidate) => candidate.trim());
  });
}

function invalidDeclaredSkillDirectoryFields(manifest, declaration = {}) {
  const containers = [
    ["declaration", declaration],
    ["manifest", manifest],
    ["declaration.layout", declaration?.layout],
    ["manifest.layout", manifest?.layout],
    ["declaration.components", declaration?.components],
    ["manifest.components", manifest?.components],
  ];
  return unique(
    containers.flatMap(([location, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      return DECLARED_SKILL_DIRECTORY_FIELDS
        .filter((field) => Object.hasOwn(value, field) && !declaredDirectoryValueIsValid(value[field]))
        .map((field) => `${location}.${field}`);
    }),
  );
}

async function directoryEntries(target, context, metadata, { reportMissing = false } = {}) {
  publishDiscoveryPerformanceMetric("plugin_directory_reads");
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
    return isPathContained(canonicalBoundary, canonicalTarget);
  } catch {
    return false;
  }
}

async function safeDirectory(target, boundary, context, metadata, { declared = false } = {}) {
  const resolvedTarget = path.resolve(target);
  const resolvedBoundary = path.resolve(boundary);
  if (!isPathContained(resolvedBoundary, resolvedTarget)) {
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
  if (info.isSymbolicLink()) {
    let targetInfo;
    try {
      targetInfo = await stat(resolvedTarget);
    } catch (error) {
      context.diagnostics.push(
        diagnostic({
          host: context.host,
          path: resolvedTarget,
          code: "PLUGIN_ROOT_UNREADABLE",
          message: `cannot inspect plugin skill root ${resolvedTarget}: ${error.message}`,
          metadata,
        }),
      );
      return undefined;
    }
    if (!targetInfo.isDirectory()) {
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
  }
  return resolvedTarget;
}

async function readJsonObject(
  file,
  context,
  {
    host = context.host,
    metadata,
    description = "plugin metadata",
    boundary,
  } = {},
) {
  context.controlPaths?.add(path.resolve(file));
  if (boundary) {
    try {
      await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      context.diagnostics.push(
        diagnostic({
          host,
          path: file,
          code: "PLUGIN_METADATA_UNREADABLE",
          message: `cannot inspect ${description} ${file}: ${error.message}`,
          metadata,
        }),
      );
      return undefined;
    }
    if (!(await canonicalContained(file, boundary))) {
      context.diagnostics.push(
        diagnostic({
          host,
          path: file,
          code: "PLUGIN_METADATA_ESCAPE",
          message: `${description} resolves outside its extension root: ${file}`,
          metadata,
        }),
      );
      return undefined;
    }
  }
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

async function readManifest(
  installRoot,
  context,
  metadata,
  { files = GENERIC_MANIFEST_FILES, description = "plugin metadata" } = {},
) {
  for (const relative of files) {
    const file = path.join(installRoot, relative);
    try {
      await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
    }
    const value = await readJsonObject(file, context, {
      host: context.host,
      metadata,
      description,
      boundary: installRoot,
    });
    if (value) return { status: "valid", value, path: file };
    return { status: "invalid", path: file };
  }
  return { status: "missing" };
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
  cache,
  active = cache?.kind !== "versioned",
  declaration = {},
  context,
  defaultSkillDirectory = "skills",
  includeDefaultSkillDirectory = true,
  manifestPolicy,
  manifestValidation,
  localPluginIdentity = pluginIdentity,
}) {
  const effectiveManifestPolicy = manifestPolicy ?? {};
  const {
    files: manifestFiles = GENERIC_MANIFEST_FILES,
    description: manifestDescription = "plugin metadata",
    requiredFields: requiredManifestFields = [],
    skipInvalidExtension = false,
    manifestOverridesDeclaration = false,
    declaredSkillDirectoriesReplaceDefault = false,
    includeRootSkillFallback = false,
    includeDefaultSkillRoot = true,
    manifestNamePattern,
  } = effectiveManifestPolicy;
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
  if (!safeInstallRoot) return false;

  const manifest = await readManifest(safeInstallRoot, context, initialMetadata, {
    files: manifestFiles,
    description: manifestDescription,
  });
  const manifestValue = manifest.status === "valid" ? manifest.value : undefined;
  let invalidManifest = manifest.status === "invalid";
  if (requiredManifestFields.length > 0) {
    if (manifest.status === "missing") {
      invalidManifest = true;
      context.diagnostics.push(
        diagnostic({
          host,
          path: safeInstallRoot,
          code: "MISSING_PLUGIN_METADATA",
          message: `missing ${manifestDescription} in ${safeInstallRoot}`,
          metadata: initialMetadata,
        }),
      );
    } else if (manifest.status === "valid") {
      for (const field of requiredManifestFields) {
        if (stringValue(manifestValue[field])) continue;
        invalidManifest = true;
        context.diagnostics.push(
          diagnostic({
            host,
            path: manifest.path,
            code: "INVALID_PLUGIN_METADATA",
            message: `${manifestDescription} is missing a valid ${field}: ${manifest.path}`,
            metadata: initialMetadata,
          }),
        );
      }
    }
  }
  if (
    manifestNamePattern
    && manifestValue
    && typeof manifestValue.name === "string"
    && !manifestNamePattern.test(manifestValue.name)
  ) {
    invalidManifest = true;
    context.diagnostics.push(
      diagnostic({
        host,
        path: manifest.path,
        code: "INVALID_PLUGIN_METADATA",
        message: `${manifestDescription} has an invalid plugin name: ${manifest.path}`,
        metadata: initialMetadata,
      }),
    );
  }
  let installationMetadata;
  let includeInstallation = true;
  if (manifestValidation) {
    const validation = await manifestValidation({
      manifest,
      safeInstallRoot,
      initialMetadata,
      context,
    });
    includeInstallation = validation?.include ?? true;
    installationMetadata = validation?.installationMetadata;
  }
  // Local/link sources identify an external origin; preserve that evidence without traversing or writing it.
  const manifestField = (field) => manifestOverridesDeclaration
    ? manifestValue?.[field] ?? declaration[field]
    : declaration[field] ?? manifestValue?.[field];
  const metadata = metadataFor({
    host,
    marketplace: manifestField("marketplace") ?? marketplace,
    name: manifestField("name") ?? name,
    version: manifestField("version") ?? version,
    root: safeInstallRoot,
    manifestPath: manifest?.path,
    source: declaration.sourceType,
  });
  const provenanceSource = sourceMetadata(
    manifestValue,
    declaration,
    installationMetadata,
    { manifestOverridesDeclaration },
  );
  const evidenceResult = pluginEvidence({
    metadata,
    source: provenanceSource,
    localPluginIdentity,
  });
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
  const invalidDeclaredFields = invalidDeclaredSkillDirectoryFields(manifestValue, declaration);
  for (const field of invalidDeclaredFields) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: manifest?.path ?? safeInstallRoot,
        code: "PLUGIN_SKILL_DIRECTORY_INVALID",
        message: `declared skill directory ${field} is invalid: ${manifest?.path ?? safeInstallRoot}`,
        metadata,
      }),
    );
  }
  if (
    !includeInstallation
    || (skipInvalidExtension && invalidManifest)
  ) {
    // Host validation can retain diagnostics without exposing an installation's skills.
    return false;
  }
  const hasDeclaredSkillDirectory =
    hasDeclaredSkillDirectoryField(manifestValue)
    || hasDeclaredSkillDirectoryField(declaration);
  let rootSkillFallback = false;
  let addedRoot = false;
  if (includeRootSkillFallback && !hasDeclaredSkillDirectory) {
    let hasDefaultSkillDirectory = false;
    try {
      const defaultSkillRoot = path.join(safeInstallRoot, defaultSkillDirectory);
      const defaultSkillInfo = await lstat(defaultSkillRoot);
      const defaultSkillIsDirectory = defaultSkillInfo.isDirectory()
        || (defaultSkillInfo.isSymbolicLink() && (await stat(defaultSkillRoot)).isDirectory());
      hasDefaultSkillDirectory =
        defaultSkillIsDirectory
        && await canonicalContained(defaultSkillRoot, safeInstallRoot);
    } catch {
      // A missing default directory is the normal root-skill fallback case.
    }
    if (!hasDefaultSkillDirectory) {
      try {
        const rootSkillPath = path.join(safeInstallRoot, "SKILL.md");
        const rootSkillInfo = await lstat(rootSkillPath);
        if (rootSkillInfo.isFile() || rootSkillInfo.isSymbolicLink()) {
          if (await canonicalContained(rootSkillPath, safeInstallRoot)) {
            rootSkillFallback = true;
          } else {
            context.diagnostics.push(
              diagnostic({
                host,
                path: rootSkillPath,
                code: "PLUGIN_ROOT_ESCAPE",
                message: `root plugin skill resolves outside its plugin root: ${rootSkillPath}`,
                metadata: initialMetadata,
              }),
            );
          }
        }
      } catch {
        rootSkillFallback = false;
      }
    }
  }
  const declaredDirectories = unique(effectiveDeclaredSkillDirectories(
    manifestValue,
    declaration,
    { manifestOverridesDeclaration: declaredSkillDirectoriesReplaceDefault },
  ));
  const directories = [
    ...(includeDefaultSkillDirectory
      && (!declaredSkillDirectoriesReplaceDefault || !hasDeclaredSkillDirectory)
      ? [defaultSkillDirectory]
      : []),
    ...declaredDirectories,
  ];
  const pluginRootInfo = (skillRoot, extra = {}) => ({
    kind: "plugin",
    path: skillRoot,
    owner: `${PLUGIN_OWNER_PREFIX}${host}`,
    owners: [`${PLUGIN_OWNER_PREFIX}${host}`],
    scope,
    origin: "plugin",
    host,
    ...extra,
    plugin: {
      host: metadata.host,
      marketplace: metadata.marketplace,
      name: metadata.name,
      ...(metadata.version ? { version: metadata.version } : {}),
    },
    pluginMetadata: metadata,
    pluginIdentity: localPluginIdentity(metadata),
    pluginEvidence: [{
      ...evidenceResult.evidence,
      ...(cache ? { cache: structuredClone(cache) } : {}),
    }],
    pluginRoot: safeInstallRoot,
    ...(active === false ? { active: false } : {}),
    ...(manifest?.path ? { pluginManifest: manifest.path } : {}),
  });
  if (rootSkillFallback) {
    context.roots.push(pluginRootInfo(safeInstallRoot, { singleSkill: true }));
    addedRoot = true;
  }
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
    context.roots.push(pluginRootInfo(skillRoot, {
      includeRootSkill: relativeDirectory !== defaultSkillDirectory || includeDefaultSkillRoot,
    }));
    addedRoot = true;
  }
  return addedRoot;
}

async function pluginDirectories(root, context, metadata, filter = () => true) {
  const entries = await directoryEntries(root, context, metadata);
  const result = [];
  for (const entry of entries) {
    // Cache directories contain metadata sidecars; only directory entries can host a plugin.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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
  active,
  manifestPolicy,
  localPluginIdentity,
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
          cache: { kind: "versioned", scope },
          context,
          ...(active === undefined ? {} : { active }),
          ...(manifestPolicy ? { manifestPolicy } : {}),
          ...(localPluginIdentity ? { localPluginIdentity } : {}),
        });
      }
    }
  }
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

function marketplaceSourceBase(file, safeBase, marketplaceRootDirectories = []) {
  const marketplaceDirectory = path.dirname(file);
  if (
    path.basename(marketplaceDirectory) === "plugins"
    && path.basename(path.dirname(marketplaceDirectory)) === ".agents"
  ) {
    return path.dirname(path.dirname(marketplaceDirectory));
  }
  if (marketplaceRootDirectories.includes(path.basename(marketplaceDirectory))) {
    return path.dirname(marketplaceDirectory);
  }
  return safeBase;
}

function marketplacePluginLocation(
  configuredPath,
  file,
  safeBase,
  declaredPluginRoot,
  marketplaceRootDirectories,
  home,
) {
  const expandedPath = configuredPath === "~"
    ? home
    : configuredPath.startsWith("~/")
      ? path.join(home, configuredPath.slice(2))
      : configuredPath;
  const sourceBase = marketplaceSourceBase(file, safeBase, marketplaceRootDirectories);
  const normalized = expandedPath.replaceAll("\\", "/");
  const usesMarketplaceRoot = !declaredPluginRoot && sourceBase !== safeBase && (
    normalized === "."
    || normalized === "./"
    || normalized === "./plugins"
    || normalized.startsWith("./plugins/")
  );
  const installRoot = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(
      declaredPluginRoot
        ? declaredPluginRoot
        : usesMarketplaceRoot
          ? sourceBase
          : safeBase,
      expandedPath,
    );
  return {
    installRoot,
    boundary: declaredPluginRoot ?? sourceBase,
  };
}

function genericMarketplacePolicy({ manifest, file, host, marketplace, context }) {
  const entriesField = ["plugins", "extensions", "entries"].find((field) =>
    Object.hasOwn(manifest, field),
  );
  if (!entriesField) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: file,
        code: "PLUGIN_MARKETPLACE_MISSING_ENTRIES",
        message: `marketplace metadata has no plugin entries: ${file}`,
        metadata: { host, marketplace },
      }),
    );
    return { valid: false, entries: [] };
  }
  const configuredEntries = manifest[entriesField];
  if (
    configuredEntries !== undefined
    && !Array.isArray(configuredEntries)
    && (!configuredEntries || typeof configuredEntries !== "object")
  ) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: file,
        code: "PLUGIN_MARKETPLACE_INVALID_ENTRIES",
        message: `marketplace plugin entries must be an array or object: ${file}`,
        metadata: { host, marketplace },
      }),
    );
    return { valid: false, entries: [] };
  }
  return { valid: true, entries: marketplaceEntries(manifest) };
}

async function discoverMarketplaceManifests({
  base,
  boundary,
  context,
  host,
  scope,
  marketplaceName,
  manifestPolicy,
  active,
  manifestFiles,
  marketplaceRootDirectories = [],
  marketplacePolicy,
  localPluginIdentity,
  onDeclaredPlugin,
}) {
  const safeBase = await safeDirectory(
    base,
    boundary,
    context,
    { host, source: "marketplace" },
  );
  if (!safeBase) return false;
  const manifestResult = await readManifest(
    safeBase,
    context,
    { host, source: "marketplace" },
    {
      files: manifestFiles ?? GENERIC_MARKETPLACE_MANIFEST_FILES,
      description: "marketplace metadata",
    },
  );
  if (manifestResult.status !== "valid") return false;
  let declaredPlugin = false;
  const { path: file, value: manifest } = manifestResult;
  const marketplace = stringValue(manifest.name) ?? marketplaceName ?? path.basename(safeBase);
  const sourceBase = marketplaceSourceBase(file, safeBase, marketplaceRootDirectories);
  const policy = marketplacePolicy ?? {
    validate: genericMarketplacePolicy,
  };
  const marketplaceResult = await policy.validate({
    manifest,
    file,
    safeBase,
    sourceBase,
    context,
    host,
    marketplace,
  });
  if (!marketplaceResult) return false;
  let declaredPluginRoot;
  if (marketplaceResult.pluginRoot) {
    declaredPluginRoot = await safeDirectory(
      path.resolve(sourceBase, marketplaceResult.pluginRoot),
      sourceBase,
      context,
      { host, marketplace, source: "marketplace" },
      { declared: true },
    );
    if (!declaredPluginRoot) return false;
  }
  if (!marketplaceResult.valid) return false;
  for (const entry of marketplaceResult.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      context.diagnostics.push(
        diagnostic({
          host,
          path: file,
          code: "PLUGIN_DECLARATION_INVALID",
          message: `marketplace plugin declaration is not an object: ${file}`,
          metadata: { host, marketplace },
        }),
      );
      continue;
    }
    if (
      policy.validateEntry
      && !(await policy.validateEntry({ entry, file, context, marketplace }))
    ) continue;
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
    const location = marketplacePluginLocation(
      configuredPath,
      file,
      safeBase,
      declaredPluginRoot,
      marketplaceRootDirectories,
      context.home,
    );
    declaredPlugin = true;
    await onDeclaredPlugin?.({
      location,
      entry,
      file,
      context,
    });
    await addPluginInstall({
      ...location,
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
      active,
      ...(manifestPolicy ? { manifestPolicy } : {}),
      ...(localPluginIdentity ? { localPluginIdentity } : {}),
    });
  }
  return declaredPlugin;
}

function normalizeWorkspaceDirectories({ cwd, home, workspaceDirectories }) {
  return unique(
    (workspaceDirectories ?? boundedWorkspaceDirectories({ cwd, home }))
      .map((directory) => typeof directory === "string" ? directory : directory.path)
      .filter(Boolean)
      .map((directory) => path.resolve(directory)),
  );
}

const PLUGIN_HOST_ROOT_FIELDS = new Set([
  "kind",
  "path",
  "owner",
  "scope",
  "origin",
  "aliases",
  "owners",
  "host",
  "plugin",
  "pluginMetadata",
  "pluginManifest",
  "pluginRoot",
  "pluginRoots",
  "pluginIdentity",
  "pluginIdentities",
  "pluginEvidence",
  "active",
  "singleSkill",
  "includeRootSkill",
]);

const PLUGIN_HOST_DIAGNOSTIC_FIELDS = new Set([
  "kind",
  "host",
  "path",
  "code",
  "message",
  "plugin",
]);

const PLUGIN_EVIDENCE_FIELDS = new Set([
  "kind",
  "host",
  "plugin",
  "marketplace",
  "version",
  "identity",
  "repository",
  "upstream_path",
  "upstreamPath",
  "cache",
  "installation",
  "provenance",
  "synced",
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDataValue(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isDataValue(entry, seen))
    : isPlainRecord(value)
      && Object.values(value).every((entry) => isDataValue(entry, seen));
  seen.delete(value);
  return valid;
}

function isDataRecord(value) {
  return isPlainRecord(value) && isDataValue(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value) {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalRecord(value) {
  return value === undefined || isDataRecord(value);
}

function isOptionalStringArray(value) {
  return value === undefined || isStringArray(value);
}

function isPluginEvidence(value, host) {
  if (
    !isDataRecord(value)
    || [...Object.keys(value)].some((field) => !PLUGIN_EVIDENCE_FIELDS.has(field))
    || value.kind !== "plugin"
    || value.host !== host
    || !isNonEmptyString(value.plugin)
    || !isNonEmptyString(value.marketplace)
    || !isOptionalString(value.version)
    || !isOptionalString(value.identity)
    || !isOptionalString(value.repository)
    || !isOptionalString(value.upstream_path)
    || !isOptionalString(value.upstreamPath)
    || !isOptionalRecord(value.installation)
    || !isOptionalRecord(value.provenance)
    || (value.synced !== undefined && typeof value.synced !== "boolean")
  ) return false;
  if (value.cache === undefined) return true;
  return isDataRecord(value.cache)
    && Object.keys(value.cache).every((field) => ["kind", "scope"].includes(field))
    && value.cache.kind === "versioned"
    && ["global", "workspace"].includes(value.cache.scope);
}

function isValidPluginHostRoot(root, host) {
  try {
    return isDataRecord(root)
      && Object.keys(root).every((field) => PLUGIN_HOST_ROOT_FIELDS.has(field))
      && root.kind === "plugin"
      && isNonEmptyString(root.path)
      && isNonEmptyString(root.owner)
      && root.owner === `plugin:${host}`
      && isNonEmptyString(root.scope)
      && root.origin === "plugin"
      && root.host === host
      && isOptionalStringArray(root.aliases)
      && isOptionalStringArray(root.owners)
      && (root.owners === undefined || root.owners.includes(root.owner))
      && isOptionalRecord(root.plugin)
      && isOptionalRecord(root.pluginMetadata)
      && isOptionalString(root.pluginManifest)
      && isOptionalString(root.pluginRoot)
      && isOptionalStringArray(root.pluginRoots)
      && isOptionalString(root.pluginIdentity)
      && isOptionalStringArray(root.pluginIdentities)
      && (root.pluginEvidence === undefined
        || Array.isArray(root.pluginEvidence)
          && root.pluginEvidence.every((value) => isPluginEvidence(value, host)))
      && isOptionalBoolean(root.active)
      && isOptionalBoolean(root.singleSkill)
      && isOptionalBoolean(root.includeRootSkill);
  } catch {
    return false;
  }
}

function isValidPluginHostDiagnostic(entry, host) {
  try {
    return isDataRecord(entry)
      && Object.keys(entry).every((field) => PLUGIN_HOST_DIAGNOSTIC_FIELDS.has(field))
      && entry.kind === "plugin"
      && entry.host === host
      && isNonEmptyString(entry.path)
      && isNonEmptyString(entry.code)
      && isNonEmptyString(entry.message)
      && isOptionalRecord(entry.plugin);
  } catch {
    return false;
  }
}

function invalidPluginHostResultDiagnostic(host, targetPath, message) {
  return diagnostic({
    host,
    path: targetPath,
    code: "PLUGIN_HOST_DISCOVERY_INVALID_RESULT",
    message,
  });
}

function appendPluginHostResult({
  result,
  host,
  targetPath,
  roots,
  diagnostics,
}) {
  if (!isPluginHostResult(result)) {
    diagnostics.push(invalidPluginHostResultDiagnostic(
      host,
      targetPath,
      `plugin discovery returned an invalid result for ${host}`,
    ));
    return;
  }
  for (const root of result.roots) {
    if (!isValidPluginHostRoot(root, host)) {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        host,
        targetPath,
        `plugin discovery returned an invalid root for ${host}`,
      ));
      continue;
    }
    try {
      roots.push(immutablePluginHostRecord(root));
    } catch {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        host,
        targetPath,
        `plugin discovery returned an uncloneable root for ${host}`,
      ));
    }
  }
  for (const entry of result.diagnostics) {
    if (!isValidPluginHostDiagnostic(entry, host)) {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        host,
        targetPath,
        `plugin discovery returned an invalid diagnostic for ${host}`,
      ));
      continue;
    }
    try {
      diagnostics.push(immutablePluginHostRecord(entry));
    } catch {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        host,
        targetPath,
        `plugin discovery returned an uncloneable diagnostic for ${host}`,
      ));
    }
  }
}

export const CLAUDE_CODE_HOST_ADAPTER = createClaudeCodeAdapter({
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
});

export const CODEX_HOST_ADAPTER = createCodexAdapter({
  addPluginInstall,
  diagnostic,
  discoverMarketplaceManifests,
  discoverVersionedPluginCache,
  pluginDirectories,
  readFile,
  safeDirectory,
});

export const GEMINI_CLI_HOST_ADAPTER = createGeminiCliAdapter({
  addPluginInstall,
  diagnostic,
  pluginDirectories,
  readJsonObject,
  safeDirectory,
});

export const CURSOR_HOST_ADAPTER = createCursorAdapter({
  addPluginInstall,
  canonicalContained,
  diagnostic,
  discoverMarketplaceManifests,
  lstat,
  pluginDirectories,
  pluginIdentity,
  realpath,
  safeDirectory,
});

export const PLUGIN_HOST_SPECIFICATIONS = Object.freeze([
  CLAUDE_CODE_HOST_ADAPTER,
  CODEX_HOST_ADAPTER,
  GEMINI_CLI_HOST_ADAPTER,
  CURSOR_HOST_ADAPTER,
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
    controlPaths: new Set(),
  };
  const roots = [];
  const diagnostics = [];
  for (const specification of hostSpecifications) {
    if (!specification || typeof specification.discover !== "function") {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        "unknown",
        context.cwd,
        "plugin host specification requires a discover function",
      ));
      continue;
    }
    if (!isNonEmptyString(specification.host)) {
      diagnostics.push(invalidPluginHostResultDiagnostic(
        "unknown",
        context.cwd,
        "plugin host specification requires a non-empty string host",
      ));
      continue;
    }
    const host = specification.host;
    const hostContext = {
      ...context,
      host,
      roots: [],
      diagnostics: [],
    };
    try {
      const result = await specification.discover(hostContext);
      appendPluginHostResult({
        result,
        host,
        targetPath: context.cwd,
        roots,
        diagnostics,
      });
    } catch (error) {
      diagnostics.push(
        diagnostic({
          host,
          path: context.cwd,
          code: "PLUGIN_HOST_DISCOVERY_FAILED",
          message: `plugin discovery failed for ${host}: ${error.message}`,
        }),
      );
    }
  }
  // Host adapters emit observations. Physical-root identity, policy merging,
  // and duplicate evidence handling belong to the Skill root registry.
  const normalizedRoots = [...roots];
  normalizedRoots.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    roots: normalizedRoots,
    diagnostics,
    controlPaths: [...context.controlPaths].sort((left, right) => left.localeCompare(right, "en")),
  };
}
