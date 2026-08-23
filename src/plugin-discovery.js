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
import { publishDiscoveryPerformanceMetric } from "./performance-diagnostics.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";

const PLUGIN_OWNER_PREFIX = "plugin:";

const GENERIC_MANIFEST_FILES = [
  "plugin.json",
  "manifest.json",
  "package.json",
];
const GENERIC_MARKETPLACE_MANIFEST_FILES = [
  "marketplace.json",
  "plugins.json",
  "manifest.json",
];
const CLAUDE_MANIFEST_POLICY = Object.freeze({
  files: [".claude-plugin/plugin.json", ...GENERIC_MANIFEST_FILES],
});
const CODEX_MANIFEST_POLICY = Object.freeze({
  files: [".codex-plugin/plugin.json", ...GENERIC_MANIFEST_FILES],
});
const GEMINI_MANIFEST_FILES = ["gemini-extension.json"];
const GEMINI_INSTALL_METADATA_FILE = ".gemini-extension-install.json";
const GEMINI_REQUIRED_MANIFEST_FIELDS = ["name", "version"];
const GEMINI_MANIFEST_POLICY = Object.freeze({
  files: GEMINI_MANIFEST_FILES,
  description: "Gemini extension metadata",
  requiredFields: GEMINI_REQUIRED_MANIFEST_FIELDS,
  installationFile: GEMINI_INSTALL_METADATA_FILE,
  nameMatchesDirectory: true,
  skipInvalidExtension: true,
});
const CURSOR_MANIFEST_POLICY = Object.freeze({
  files: [".cursor-plugin/plugin.json", "plugin.json"],
  description: "Cursor plugin metadata",
  requiredFields: ["name"],
  skipInvalidExtension: true,
  manifestOverridesDeclaration: true,
  declaredSkillDirectoriesReplaceDefault: true,
  includeRootSkillFallback: true,
  includeDefaultSkillRoot: false,
  manifestNamePattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
});
const HOST_MANIFEST_POLICIES = Object.freeze({
  "claude-code": CLAUDE_MANIFEST_POLICY,
  codex: CODEX_MANIFEST_POLICY,
  "gemini-cli": GEMINI_MANIFEST_POLICY,
  cursor: CURSOR_MANIFEST_POLICY,
});
const HOST_MARKETPLACE_MANIFEST_FILES = Object.freeze({
  "claude-code": [
    ".claude-plugin/marketplace.json",
    ...GENERIC_MARKETPLACE_MANIFEST_FILES,
  ],
  codex: GENERIC_MARKETPLACE_MANIFEST_FILES,
  cursor: [
    ".cursor-plugin/marketplace.json",
    ...GENERIC_MARKETPLACE_MANIFEST_FILES,
  ],
});
const CURSOR_MARKETPLACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
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
}) {
  const effectiveManifestPolicy = manifestPolicy ?? HOST_MANIFEST_POLICIES[host] ?? {};
  const {
    files: manifestFiles = GENERIC_MANIFEST_FILES,
    description: manifestDescription = "plugin metadata",
    requiredFields: requiredManifestFields = [],
    installationFile: installationMetadataFile,
    nameMatchesDirectory = false,
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
  if (
    nameMatchesDirectory
    && manifestValue
    && stringValue(manifestValue.name)
    && stringValue(manifestValue.name) !== path.basename(safeInstallRoot)
  ) {
    invalidManifest = true;
    context.diagnostics.push(
      diagnostic({
        host,
        path: manifest.path,
        code: "INVALID_PLUGIN_METADATA",
        message: `Gemini extension name must match its extension directory: ${manifest.path}`,
        metadata: initialMetadata,
      }),
    );
  }
  const installationMetadataPath = installationMetadataFile
    ? path.join(safeInstallRoot, installationMetadataFile)
    : undefined;
  let installationMetadata = installationMetadataPath
    ? await readJsonObject(installationMetadataPath, context, {
      host,
      metadata: initialMetadata,
      description: "Gemini extension installation metadata",
      boundary: safeInstallRoot,
    })
    : undefined;
  if (
    installationMetadataFile
    && installationMetadata
    && (
      !stringValue(installationMetadata.source)
      || !["git", "github-release", "local", "link"].includes(installationMetadata.type)
    )
  ) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: installationMetadataPath,
        code: "INVALID_PLUGIN_INSTALL_METADATA",
        message: `invalid Gemini extension installation metadata: ${installationMetadataPath}`,
        metadata: initialMetadata,
      }),
    );
    installationMetadata = undefined;
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
    skipInvalidExtension
    && invalidManifest
  ) {
    // Hosts that reject invalid plugin metadata retain diagnostics without exposing its skills.
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
    pluginIdentity: pluginIdentity(metadata),
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

async function cursorMarketplaceManifestStatus(root) {
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

function marketplaceOwnedRoots(context, host) {
  let roots = context.marketplaceOwnedRootsByHost.get(host);
  if (!roots) {
    roots = new Set();
    context.marketplaceOwnedRootsByHost.set(host, roots);
  }
  return roots;
}

async function discoverCursorLocalPluginRoots({
  root,
  boundary = root,
  scope,
  context,
}) {
  const safeRoot = await safeDirectory(
    root,
    boundary,
    context,
    { host: "cursor", source: "extension" },
  );
  if (!safeRoot) return;
  const ownedRoots = marketplaceOwnedRoots(context, "cursor");
  for (const extension of await pluginDirectories(
    safeRoot,
    context,
    { host: "cursor", source: "extension" },
  )) {
    const canonicalExtension = await realpath(extension.path).catch(() => undefined);
    if (canonicalExtension && ownedRoots.has(canonicalExtension)) continue;
    const marketplaceManifest = await cursorMarketplaceManifestStatus(extension.path);
    if (marketplaceManifest.present) {
      // A direct child can itself be a documented multi-plugin repository.
      const discoveredMarketplace = await discoverMarketplaceManifests({
        base: extension.path,
        boundary: safeRoot,
        context,
        host: "cursor",
        scope,
        marketplaceName: "local",
        manifestPolicy: CURSOR_MANIFEST_POLICY,
      });
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
      context,
      manifestPolicy: CURSOR_MANIFEST_POLICY,
    });
  }
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
          cache: { kind: "versioned", scope },
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

function marketplaceEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const plugins = value.plugins ?? value.extensions ?? value.entries;
  if (Array.isArray(plugins)) return plugins;
  if (!plugins || typeof plugins !== "object") return [];
  return Object.entries(plugins).map(([name, entry]) =>
    typeof entry === "string" ? { name, path: entry } : { name, ...entry },
  );
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

async function codexMarketplaceDeclarations(codexHome, context) {
  const file = path.join(codexHome, "config.toml");
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
      active: false,
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
  }
  await discoverMarketplaceManifests({
    base: path.join(home, ".agents", "plugins"),
    boundary: home,
    context,
    host: "codex",
    scope: "global",
    marketplaceName: "personal",
  });
  const syncedMarketplaceRoot = path.join(codexHome, ".tmp", "plugins");
  await discoverMarketplaceManifests({
    base: path.join(syncedMarketplaceRoot, ".agents", "plugins"),
    boundary: syncedMarketplaceRoot,
    context,
    host: "codex",
    scope: "global",
  });
  const bundledMarketplacesRoot = path.join(codexHome, ".tmp", "bundled-marketplaces");
  for (const marketplace of await pluginDirectories(
    bundledMarketplacesRoot,
    context,
    { host: "codex", source: "bundled-marketplace" },
  )) {
    await discoverMarketplaceManifests({
      base: path.join(marketplace.path, ".agents", "plugins"),
      boundary: marketplace.path,
      context,
      host: "codex",
      scope: "global",
      marketplaceName: marketplace.entry.name,
      active: false,
    });
  }
  for (const workspace of context.workspaceDirectories) {
    await discoverMarketplaceManifests({
      base: path.join(workspace, ".agents", "plugins"),
      boundary: workspace,
      context,
      host: "codex",
      scope: "workspace",
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
  manifestPolicy,
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
      ...(manifestPolicy ? { manifestPolicy } : {}),
    });
  }
}

async function discoverGemini(context) {
  const { home, env } = context;
  // Gemini resolves GEMINI_CLI_HOME as a user-home override, then appends .gemini.
  const geminiCliHome = path.resolve(stringValue(env.GEMINI_CLI_HOME) ?? home);
  const geminiHome = path.join(geminiCliHome, ".gemini");
  await discoverDirectExtensionRoots({
    root: path.join(geminiHome, "extensions"),
    boundary: geminiHome,
    host: "gemini-cli",
    scope: "global",
    context,
    manifestPolicy: GEMINI_MANIFEST_POLICY,
  });
  for (const workspace of context.workspaceDirectories) {
    await discoverDirectExtensionRoots({
      root: path.join(workspace, ".gemini", "extensions"),
      boundary: workspace,
      host: "gemini-cli",
      scope: "workspace",
      context,
      manifestPolicy: GEMINI_MANIFEST_POLICY,
    });
  }
}

async function discoverCursor(context) {
  const { home, env } = context;
  const cursorHome = path.resolve(
    stringValue(env.CURSOR_HOME) ?? path.join(home, ".cursor"),
  );
  const globalRoot = path.join(cursorHome, "plugins", "local");
  // A valid marketplace owns its declared installs; direct discovery is the fallback.
  await discoverMarketplaceManifests({
    base: globalRoot,
    boundary: cursorHome,
    context,
    host: "cursor",
    scope: "global",
    marketplaceName: "local",
    manifestPolicy: CURSOR_MANIFEST_POLICY,
  });
  await discoverCursorLocalPluginRoots({
    root: globalRoot,
    boundary: cursorHome,
    scope: "global",
    context,
  });
  for (const workspace of context.workspaceDirectories) {
    const workspaceRoot = path.join(workspace, ".cursor", "plugins", "local");
    await discoverMarketplaceManifests({
      base: workspaceRoot,
      boundary: workspace,
      context,
      host: "cursor",
      scope: "workspace",
      marketplaceName: "local",
      manifestPolicy: CURSOR_MANIFEST_POLICY,
    });
    await discoverCursorLocalPluginRoots({
      root: workspaceRoot,
      boundary: workspace,
      scope: "workspace",
      context,
    });
  }
}

function marketplaceSourceBase(file, safeBase) {
  const marketplaceDirectory = path.dirname(file);
  if (
    path.basename(marketplaceDirectory) === "plugins"
    && path.basename(path.dirname(marketplaceDirectory)) === ".agents"
  ) {
    return path.dirname(path.dirname(marketplaceDirectory));
  }
  if ([".claude-plugin", ".cursor-plugin"].includes(path.basename(marketplaceDirectory))) {
    return path.dirname(marketplaceDirectory);
  }
  return safeBase;
}

function marketplacePluginLocation(configuredPath, file, safeBase, declaredPluginRoot) {
  const sourceBase = marketplaceSourceBase(file, safeBase);
  const normalized = configuredPath.replaceAll("\\", "/");
  const usesMarketplaceRoot = !declaredPluginRoot && sourceBase !== safeBase && (
    normalized === "."
    || normalized === "./"
    || normalized === "./plugins"
    || normalized.startsWith("./plugins/")
  );
  const installRoot = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(
      declaredPluginRoot
        ? declaredPluginRoot
        : usesMarketplaceRoot
          ? sourceBase
          : safeBase,
      configuredPath,
    );
  return {
    installRoot,
    boundary: declaredPluginRoot ?? sourceBase,
  };
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
      files: HOST_MARKETPLACE_MANIFEST_FILES[host]
        ?? GENERIC_MARKETPLACE_MANIFEST_FILES,
      description: "marketplace metadata",
    },
  );
  if (manifestResult.status !== "valid") return false;
  let declaredPlugin = false;
  const { path: file, value: manifest } = manifestResult;
  const marketplace = stringValue(manifest.name) ?? marketplaceName ?? path.basename(safeBase);
  let validCursorMarketplace = true;
  if (
    host === "cursor"
    && (
      typeof manifest.name !== "string"
      || !CURSOR_MARKETPLACE_NAME_PATTERN.test(manifest.name)
    )
  ) {
    validCursorMarketplace = false;
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
    host === "cursor"
    && (
      !owner
      || typeof owner !== "object"
      || Array.isArray(owner)
      || typeof owner.name !== "string"
      || !owner.name.trim()
    )
  ) {
    validCursorMarketplace = false;
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
  const pluginRoot = host === "cursor" ? manifest.metadata?.pluginRoot : undefined;
  if (
    host === "cursor"
    && Object.hasOwn(manifest.metadata ?? {}, "pluginRoot")
    && !stringValue(pluginRoot)
  ) {
    validCursorMarketplace = false;
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
  const sourceBase = marketplaceSourceBase(file, safeBase);
  let declaredPluginRoot;
  if (host === "cursor" && stringValue(pluginRoot)) {
    declaredPluginRoot = await safeDirectory(
      path.resolve(sourceBase, stringValue(pluginRoot)),
      sourceBase,
      context,
      { host, marketplace, source: "marketplace" },
      { declared: true },
    );
    if (!declaredPluginRoot) validCursorMarketplace = false;
  }
  const entriesField = host === "cursor"
    ? (Object.hasOwn(manifest, "plugins") ? "plugins" : undefined)
    : ["plugins", "extensions", "entries"].find((field) =>
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
    return false;
  }
  const configuredEntries = manifest[entriesField];
  if (
    (host === "cursor" && !Array.isArray(configuredEntries))
    || (
      host !== "cursor"
      && configuredEntries !== undefined
      && !Array.isArray(configuredEntries)
      && (!configuredEntries || typeof configuredEntries !== "object")
    )
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
    return false;
  }
  if (host === "cursor" && configuredEntries.length > 500) {
    context.diagnostics.push(
      diagnostic({
        host,
        path: file,
        code: "PLUGIN_MARKETPLACE_TOO_MANY_ENTRIES",
        message: `Cursor marketplace has more than 500 plugins: ${file}`,
        metadata: { host, marketplace },
      }),
    );
    return false;
  }
  if (host === "cursor" && !validCursorMarketplace) return false;
  for (const entry of marketplaceEntries(manifest)) {
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
      host === "cursor"
      && (
        typeof entry.name !== "string"
        || !CURSOR_MARKETPLACE_NAME_PATTERN.test(entry.name)
      )
    ) {
      context.diagnostics.push(
        diagnostic({
          host,
          path: file,
          code: "PLUGIN_DECLARATION_INVALID_NAME",
          message: `Cursor marketplace plugin name is invalid: ${file}`,
          metadata: { host, marketplace, name: entry.name },
        }),
      );
      continue;
    }
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
    );
    declaredPlugin = true;
    if (
      host === "cursor"
      && await canonicalContained(location.installRoot, location.boundary)
    ) {
      const canonicalRoot = await realpath(location.installRoot).catch(() => undefined);
      if (canonicalRoot) marketplaceOwnedRoots(context, host).add(canonicalRoot);
    }
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
    marketplaceOwnedRootsByHost: new Map(),
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
  // Host adapters emit observations. Physical-root identity, policy merging,
  // and duplicate evidence handling belong to the Skill root registry.
  const roots = context.roots.map((item) => ({
    ...item,
    kind: item.kind ?? "plugin",
  }));
  roots.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    roots,
    diagnostics: context.diagnostics,
  };
}
