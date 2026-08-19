import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateDescriptor } from "./descriptor.js";
import { DiscoveryError } from "./errors.js";
import { fingerprintFile, fingerprintPath } from "./fingerprint.js";
import {
  collectManagerRecords,
  managerSkillRoots,
} from "./manager-collector.js";
import {
  isRepositoryLocator,
  normalizeRepositoryLocator,
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";
import { parseSkillMetadata } from "./skill-metadata.js";
import { discoverPluginSkillRoots } from "./plugin-discovery.js";
import { registrySkillRoots } from "./skill-root-registry.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";

const execFile = promisify(execFileCallback);
const EVIDENCE_ORDER = new Map([
  ["explicit", 0],
  ["git", 1],
  ["plugin", 2],
  ["manager", 3],
  ["embedded", 4],
  ["confirmation", 5],
]);

function root(pathname, owner, scope, origin = owner, metadata = {}) {
  return {
    ...metadata,
    path: path.resolve(pathname),
    owner,
    owners: [...new Set(metadata.owners ?? [owner])],
    scope,
    origin,
  };
}

function containsPath(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueRoots(roots) {
  const byPath = new Map();
  for (const item of roots) {
    const normalized = typeof item === "string"
      ? root(item, "custom", "custom")
      : root(
        item.path,
        item.owner ?? "custom",
        item.scope ?? "custom",
        item.origin,
        item,
      );
    const existing = byPath.get(normalized.path);
    if (!existing) {
      byPath.set(normalized.path, normalized);
      continue;
    }
    existing.owners = [
      ...new Set([...existing.owners, ...normalized.owners]),
    ];
    existing.aliases = [
      ...new Set([
        ...(existing.aliases ?? [existing.path]),
        ...(normalized.aliases ?? [normalized.path]),
      ]),
    ];
    existing.registries = [
      ...new Set([
        ...(existing.registries ?? [existing.registry].filter(Boolean)),
        ...(normalized.registries ?? [normalized.registry].filter(Boolean)),
      ]),
    ];
    if (existing.scope !== normalized.scope) {
      existing.scopes = [
        ...new Set([...(existing.scopes ?? [existing.scope]), normalized.scope]),
      ];
    }
    existing.pluginEvidence = [
      ...new Map([
        ...(existing.pluginEvidence ?? []).map((value) => [JSON.stringify(value), value]),
        ...(normalized.pluginEvidence ?? []).map((value) => [JSON.stringify(value), value]),
      ]).values(),
    ];
    existing.pluginIdentities = [
      ...new Set([
        ...(existing.pluginIdentities ?? []).filter(Boolean),
        existing.pluginIdentity,
        ...(normalized.pluginIdentities ?? []).filter(Boolean),
        normalized.pluginIdentity,
      ]),
    ].filter(Boolean);
    if (!existing.pluginMetadata && normalized.pluginMetadata) {
      existing.pluginMetadata = structuredClone(normalized.pluginMetadata);
    }
    if (!existing.plugin && normalized.plugin) {
      existing.plugin = structuredClone(normalized.plugin);
    }
  }
  return [...byPath.values()];
}

async function uniquePhysicalRoots(roots) {
  const byPhysicalPath = new Map();
  for (const item of uniqueRoots(roots)) {
    const physicalPath = await realpath(item.path).catch(() => item.path);
    const existing = byPhysicalPath.get(physicalPath);
    if (!existing) {
      byPhysicalPath.set(physicalPath, { ...item, physicalPath });
      continue;
    }
    const [merged] = uniqueRoots([
      existing,
      {
        ...item,
        path: existing.path,
        aliases: [
          ...(existing.aliases ?? [existing.path]),
          ...(item.aliases ?? [item.path]),
        ],
      },
    ]);
    byPhysicalPath.set(physicalPath, { ...merged, physicalPath });
  }
  return [...byPhysicalPath.values()];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalManagerProvenance(record) {
  const provenance = record.provenance && typeof record.provenance === "object"
    ? { ...record.provenance }
    : {};
  const source = record.source && typeof record.source === "object"
    ? record.source
    : {};
  const repository = source.repository ?? provenance.repository;
  const upstreamPath = normalizeUpstreamEntrypoint(
    source.upstream_path
      ?? source.upstreamPath
      ?? provenance.upstream_path
      ?? provenance.upstreamPath,
  );
  delete provenance.upstreamPath;
  if (repository) {
    provenance.kind = "repository";
    provenance.repository = normalizeRepositoryUrl(repository);
    if (upstreamPath) provenance.upstream_path = upstreamPath;
  } else if (source.identity && !provenance.identity) {
    provenance.kind ??= "local";
    provenance.identity = source.identity;
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

export function hostSkillRoots({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
  claudeSettings = {},
} = {}) {
  const workspaceDirectories = boundedWorkspaceDirectories({ cwd, home });
  const resolvedCwd = path.resolve(cwd);
  const roots = registrySkillRoots({
    home,
    env,
    workspaceDirectories: workspaceDirectories.map((directory) => ({
      path: directory,
      origin: directory === resolvedCwd ? "project" : "ancestor",
    })),
  });
  const additions = [
    ...(claudeSettings.additionalDirectories ?? []),
    ...(claudeSettings.permissions?.additionalDirectories ?? []),
  ];
  for (const directory of additions) {
    roots.push(
      root(
        path.basename(directory) === "skills"
          ? directory
          : path.join(directory, ".claude", "skills"),
        "claude-additional",
        "workspace",
        "host-added",
      ),
    );
  }
  for (const directory of (env.COPILOT_SKILLS_DIRS ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    roots.push(root(directory, "copilot-env", "workspace", "host-added"));
  }
  return uniqueRoots(roots);
}

function resolveConfiguredDirectory(value, { base, home }) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const configured = value.trim();
  if (configured === "~") return path.resolve(home);
  if (configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")) {
    return path.resolve(home, configured.slice(2));
  }
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(base, configured);
}

export async function configuredHostSkillRoots({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const candidates = new Map();
  candidates.set(path.join(home, ".claude", "settings.json"), home);
  for (const directory of boundedWorkspaceDirectories({ cwd, home })) {
    candidates.set(path.join(directory, ".claude", "settings.json"), directory);
    candidates.set(path.join(directory, ".claude", "settings.local.json"), directory);
  }
  const settingsEvidence = [];
  const diagnostics = [];
  const additionalDirectories = [];
  for (const [settingsPath, base] of candidates) {
    let settings;
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        diagnostics.push({
          kind: "claude-settings",
          file: settingsPath,
          status: "error",
          error: error.message,
        });
      }
      continue;
    }
    for (const [key, configuredValues] of [
      ["additionalDirectories", settings?.additionalDirectories],
      ["permissions.additionalDirectories", settings?.permissions?.additionalDirectories],
    ]) {
      if (configuredValues === undefined) continue;
      if (!Array.isArray(configuredValues)) {
        diagnostics.push({
          kind: "claude-settings",
          file: settingsPath,
          key,
          status: "error",
          error: "must be an array",
        });
        continue;
      }
      for (const configuredValue of configuredValues) {
        const directory = resolveConfiguredDirectory(configuredValue, { base, home });
        if (!directory) {
          diagnostics.push({
            kind: "claude-settings",
            file: settingsPath,
            key,
            status: "error",
            error: "directory must be a non-empty string",
          });
          continue;
        }
        additionalDirectories.push(directory);
        settingsEvidence.push({
          kind: "claude-settings",
          file: settingsPath,
          key,
          configured: configuredValue,
          directory,
        });
      }
    }
  }
  return {
    roots: hostSkillRoots({
      home,
      cwd,
      env,
      claudeSettings: { additionalDirectories: [...new Set(additionalDirectories)] },
    }),
    settingsEvidence,
    diagnostics,
  };
}

async function exists(target) {
  return access(target).then(
    () => true,
    () => false,
  );
}

async function inspectFilesystemInput(input, cwd) {
  const resolved = path.resolve(cwd, input);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    return { exists: false };
  }
  if (
    (info.isDirectory() || info.isSymbolicLink()) &&
    (await exists(path.join(resolved, "SKILL.md")))
  ) {
    return { exists: true, skillDirectory: resolved };
  }
  if (info.isFile() && path.basename(resolved) === "SKILL.md") {
    return { exists: true, skillDirectory: path.dirname(resolved) };
  }
  return { exists: true };
}

async function scanRoot(rootInfo) {
  let entries;
  try {
    entries = await readdir(rootInfo.path, { withFileTypes: true });
  } catch (error) {
    if (rootInfo.origin !== "plugin") return { candidates: [], failures: [], diagnostics: [] };
    return {
      candidates: [],
      failures: [],
      diagnostics: [{
        kind: "plugin",
        host: rootInfo.host,
        path: path.resolve(rootInfo.path),
        code: "PLUGIN_ROOT_UNREADABLE",
        message: `cannot read plugin skill root ${rootInfo.path}: ${error.message}`,
        ...(rootInfo.plugin
          ? { plugin: structuredClone(rootInfo.plugin) }
          : {}),
      }],
    };
  }
  const directories = [];
  const diagnostics = [];
  const canonicalPluginRoot = rootInfo.pluginRoot
    ? await realpath(rootInfo.pluginRoot).catch(() => undefined)
    : undefined;
  const isContainedPluginDirectory = async (directory) => {
    if (!canonicalPluginRoot || rootInfo.origin !== "plugin") return true;
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (!canonicalDirectory || containsPath(canonicalPluginRoot, canonicalDirectory)) return true;
    diagnostics.push({
      kind: "plugin",
      host: rootInfo.host,
      path: path.resolve(directory),
      code: "PLUGIN_ROOT_ESCAPE",
      message: `plugin skill directory resolves outside its plugin root: ${directory}`,
      ...(rootInfo.plugin ? { plugin: structuredClone(rootInfo.plugin) } : {}),
    });
    return false;
  };
  if (
    (rootInfo.singleSkill || rootInfo.includeRootSkill !== false)
    && await exists(path.join(rootInfo.path, "SKILL.md"))
  ) directories.push(rootInfo.path);
  if (!rootInfo.singleSkill) {
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const directory = path.join(rootInfo.path, entry.name);
        if (
          await exists(path.join(directory, "SKILL.md"))
          && await isContainedPluginDirectory(directory)
        ) directories.push(directory);
      }
    }
  }
  const results = await Promise.allSettled(
    directories.map((directory) => candidateFromDirectory(directory, rootInfo)),
  );
  return {
    candidates: results
      .filter(({ status }) => status === "fulfilled")
      .map(({ value }) => value),
    failures: results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ directory: directories[index], error: result.reason }]
        : []),
    diagnostics,
  };
}

async function gitEvidence(directory) {
  try {
    const { stdout: topLevelOutput } = await execFile("git", [
      "-C",
      directory,
      "rev-parse",
      "--show-toplevel",
    ]);
    const topLevel = await realpath(topLevelOutput.trim()).catch(() =>
      path.resolve(topLevelOutput.trim()),
    );
    const canonicalDirectory = await realpath(directory).catch(() =>
      path.resolve(directory),
    );
    const { stdout: remoteOutput } = await execFile("git", [
      "-C",
      directory,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    const repository = normalizeRepositoryUrl(remoteOutput.trim());
    const upstreamPath = normalizeUpstreamEntrypoint(
      path
        .relative(topLevel, path.join(canonicalDirectory, "SKILL.md"))
        .split(path.sep)
        .join("/"),
    );
    return {
      kind: "git",
      repository,
      upstream_path: upstreamPath,
      upstreamPath,
    };
  } catch {
    return undefined;
  }
}

async function embeddedEvidence(directory) {
  const file = path.join(directory, ".skill-source.json");
  try {
    const metadata = JSON.parse(await readFile(file, "utf8"));
    const source = metadata.source ?? metadata;
    if (source.kind === "repository" && source.repository) {
      const upstreamPath = normalizeUpstreamEntrypoint(
        source.upstream_path ?? source.upstreamPath,
      );
      return {
        kind: "embedded",
        repository: normalizeRepositoryUrl(source.repository),
        ...(upstreamPath ? { upstream_path: upstreamPath, upstreamPath } : {}),
      };
    }
    if (source.kind === "local" && source.identity) {
      return { kind: "embedded", identity: source.identity };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new DiscoveryError(`malformed embedded source metadata ${file}: ${error.message}`, {
        code: "MALFORMED_SOURCE_METADATA",
      });
    }
  }
  return undefined;
}

async function adjacentCustomization(directory) {
  const descriptorPath = path.join(directory, "customization.json");
  let contents;
  try {
    contents = await readFile(descriptorPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new DiscoveryError(`cannot read adjacent customization metadata ${descriptorPath}: ${error.message}`, {
      code: "MALFORMED_CUSTOMIZATION_METADATA",
    });
  }
  let descriptor;
  try {
    descriptor = JSON.parse(contents);
  } catch (error) {
    throw new DiscoveryError(`malformed customization metadata ${descriptorPath}: ${error.message}`, {
      code: "MALFORMED_CUSTOMIZATION_METADATA",
    });
  }
  const errors = validateDescriptor(descriptor);
  if (errors.length > 0 || descriptor.name !== path.basename(directory)) {
    throw new DiscoveryError(`invalid customization metadata ${descriptorPath}`, {
      code: "MALFORMED_CUSTOMIZATION_METADATA",
      details: errors.length > 0
        ? errors
        : [{ path: "/name", message: "must match its directory name" }],
    });
  }
  return descriptor;
}

async function candidateFromDirectory(directory, rootInfo) {
  const entrypoint = path.join(directory, "SKILL.md");
  const markdown = await readFile(entrypoint, "utf8");
  const realDirectory = await realpath(directory).catch(() => path.resolve(directory));
  const customization = await adjacentCustomization(realDirectory);
  return {
    name: parseSkillMetadata(markdown).name ?? path.basename(directory),
    path: path.resolve(directory),
    realPath: realDirectory,
    entrypoint,
    owner: rootInfo.owner,
    owners: rootInfo.owners ?? [rootInfo.owner],
    scope: rootInfo.scope,
    origin: rootInfo.origin,
    ...(rootInfo.plugin ? { plugin: structuredClone(rootInfo.plugin) } : {}),
    ...(rootInfo.pluginMetadata
      ? { pluginMetadata: structuredClone(rootInfo.pluginMetadata) }
      : {}),
    ...(rootInfo.pluginIdentity ? { pluginIdentity: rootInfo.pluginIdentity } : {}),
    ...(rootInfo.pluginEvidence
      ? { pluginEvidence: structuredClone(rootInfo.pluginEvidence) }
      : {}),
    fingerprint: customization?.owned_payload.reviewed_fingerprint
      ?? (rootInfo.singleSkill
        ? await fingerprintFile(entrypoint)
        : await fingerprintPath(directory)),
    classification: customization ? "customization" : "skill",
    ...(customization
      ? {
          customization: {
            id: customization.id,
            type: customization.type,
            license: customization.license,
            reviewedPayloadFingerprint:
              customization.owned_payload.reviewed_fingerprint,
          },
        }
      : {}),
    evidence: [...(rootInfo.pluginEvidence ?? [])],
  };
}

function managerEvidenceFor(candidate, records) {
  const candidatePaths = new Set([candidate.path, candidate.realPath, candidate.entrypoint]);
  const managerOwners = (candidate.owners ?? [candidate.owner]).filter((owner) =>
    owner.startsWith("manager:"),
  );
  return records
    .filter((record) => {
      if (
        managerOwners.length > 0
        && !managerOwners.includes(`manager:${record.manager}`)
      ) {
        return false;
      }
      if (!record.path) return false;
      const recordPath = path.resolve(record.path);
      return (
        candidatePaths.has(recordPath) ||
        candidatePaths.has(path.dirname(recordPath)) ||
        recordPath === candidate.path
      );
    })
    .map((record) => {
      const provenance = canonicalManagerProvenance(record);
      const repository = provenance?.repository;
      const upstreamPath = provenance?.upstream_path;
      const identity = record.source?.identity ?? provenance?.identity;
      return {
        kind: "manager",
        manager: record.manager,
        ...(repository ? { repository } : {}),
        ...(identity ? { identity } : {}),
        ...(upstreamPath
          ? { upstream_path: upstreamPath, upstreamPath }
          : {}),
        ...(provenance ? { provenance } : {}),
      };
    });
}

function uniqueOrderedEvidence(evidence) {
  const unique = new Map();
  for (const item of evidence) unique.set(JSON.stringify(item), item);
  return [...unique.values()].sort(
    (left, right) =>
      (EVIDENCE_ORDER.get(left.kind) ?? 99)
      - (EVIDENCE_ORDER.get(right.kind) ?? 99),
  );
}

function evidenceIdentity(evidence) {
  if (evidence.repository) {
    const upstreamPath = normalizeUpstreamEntrypoint(
      evidence.upstream_path ?? evidence.upstreamPath,
    );
    return `repository:${evidence.repository}${upstreamPath ? `#${upstreamPath}` : ""}`;
  }
  if (evidence.identity) {
    return evidence.identity.startsWith("local:")
      ? evidence.identity
      : `local:${evidence.identity}`;
  }
  if (evidence.provenance) return `manager-source:${stableJson(evidence.provenance)}`;
  return undefined;
}

function summarizeProvenance(evidence) {
  const repositories = new Map();
  const local = new Set();
  for (const item of evidence) {
    if (item.repository) {
      const repository = normalizeRepositoryUrl(item.repository);
      const upstreamPath = normalizeUpstreamEntrypoint(
        item.upstream_path ?? item.upstreamPath,
      );
      const paths = repositories.get(repository) ?? new Set();
      if (upstreamPath) paths.add(upstreamPath);
      repositories.set(repository, paths);
      continue;
    }
    const identity = evidenceIdentity(item);
    if (identity) local.add(identity);
  }
  const identities = [];
  for (const [repository, paths] of repositories) {
    if (paths.size === 0) identities.push(`repository:${repository}`);
    else {
      for (const upstreamPath of paths) {
        identities.push(`repository:${repository}#${upstreamPath}`);
      }
    }
  }
  identities.push(...local);
  const repositoryPathConflict = [...repositories.values()].some(
    (paths) => paths.size > 1,
  );
  return {
    identities: identities.sort(),
    conflict:
      repositories.size > 1
      || repositoryPathConflict
      || local.size > 1
      || (repositories.size > 0 && local.size > 0),
  };
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.name}\0${candidate.fingerprint}`;
    const group = groups.get(key) ?? {
      name: candidate.name,
      fingerprint: candidate.fingerprint,
      copies: [],
      evidence: [],
      provenance: [],
      conflict: false,
    };
    const copyEvidence = uniqueOrderedEvidence(candidate.evidence);
    const copyProvenance = summarizeProvenance(copyEvidence);
    group.copies.push({
      path: candidate.path,
      realPath: candidate.realPath,
      owner: candidate.owner,
      owners: candidate.owners,
      scope: candidate.scope,
      origin: candidate.origin,
      ...(candidate.plugin ? { plugin: structuredClone(candidate.plugin) } : {}),
      ...(candidate.pluginMetadata
        ? { pluginMetadata: structuredClone(candidate.pluginMetadata) }
        : {}),
      ...(candidate.pluginIdentity ? { pluginIdentity: candidate.pluginIdentity } : {}),
      evidence: copyEvidence,
      provenance: copyProvenance.identities,
      conflict: copyProvenance.conflict,
      classification: candidate.classification,
      ...(candidate.customization
        ? { customization: structuredClone(candidate.customization) }
        : {}),
    });
    group.evidence.push(...candidate.evidence);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.evidence = uniqueOrderedEvidence(group.evidence);
    const provenance = summarizeProvenance(group.evidence);
    group.provenance = provenance.identities;
    group.conflict = provenance.conflict;
  }
  const result = [...groups.values()];
  const nameCounts = new Map();
  for (const group of result) nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  for (const group of result) group.nameCollision = nameCounts.get(group.name) > 1;
  return result.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export async function discoverSkills({
  input,
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
  roots,
  additionalRoots = [],
  includePlugins = true,
  pluginDiscovery = discoverPluginSkillRoots,
  pluginOptions,
  managerRecords,
  managerOptions,
  managerCollector = collectManagerRecords,
  customPath,
} = {}) {
  let managerDiagnostics = [];
  if (managerRecords === undefined) {
    const collected = await managerCollector({ home, cwd, env, ...managerOptions });
    managerRecords = collected.records;
    managerDiagnostics = collected.diagnostics;
  }
  const rootsAreExplicit = roots !== undefined;
  // An omitted roots option is the ambient mode; an explicit empty array is intentionally deterministic.
  let pluginRoots = [];
  let pluginDiagnostics = [];
  if (!rootsAreExplicit && includePlugins !== false) {
    const plugins = await pluginDiscovery({
      home,
      cwd,
      env,
      ...pluginOptions,
    });
    pluginRoots = plugins.roots ?? [];
    pluginDiagnostics = plugins.diagnostics ?? [];
  }
  // Manager records and customPath are explicit evidence sources; roots controls ambient host/plugin roots.
  const declaredRoots = [
    ...(rootsAreExplicit ? roots : hostSkillRoots({ home, cwd, env })),
    ...(rootsAreExplicit ? [] : additionalRoots),
    ...pluginRoots,
    ...managerSkillRoots(managerRecords),
    ...(customPath ? [{ path: customPath, owner: "custom", scope: "custom" }] : []),
  ];
  const filesystemInput = input
    ? await inspectFilesystemInput(input, cwd)
    : { exists: false };
  const explicitDirectory = filesystemInput.skillDirectory;
  const repositoryInput = Boolean(
    input && !filesystemInput.exists && isRepositoryLocator(input),
  );
  if (explicitDirectory) {
    declaredRoots.push(root(explicitDirectory, "explicit", "custom", "custom-path"));
  }
  const normalizedRoots = await uniquePhysicalRoots(declaredRoots);
  const scans = await Promise.all(normalizedRoots.map(scanRoot));
  const candidates = scans.flatMap(({ candidates: rootCandidates }) =>
    rootCandidates
  );
  const candidateFailures = scans.flatMap(({ failures }) => failures);
  const scanDiagnostics = scans.flatMap(({ diagnostics = [] }) => diagnostics);
  pluginDiagnostics.push(...scanDiagnostics.filter(({ kind }) => kind === "plugin"));
  const explicitTarget = explicitDirectory
    ? await realpath(explicitDirectory).catch(() => path.resolve(explicitDirectory))
    : undefined;
  const deduped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.path}\0${candidate.owner}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  const enrichmentCandidates = [...deduped.values()];
  const enrichmentResults = await Promise.allSettled(
    enrichmentCandidates.map(async (candidate) => {
      if (
        explicitDirectory
        && path.resolve(candidate.realPath ?? candidate.path) === explicitTarget
      ) {
        candidate.evidence.push({
          kind: "explicit",
          path: path.resolve(explicitDirectory),
        });
      }
      const git = await gitEvidence(candidate.path);
      if (git) candidate.evidence.push(git);
      candidate.evidence.push(...managerEvidenceFor(candidate, managerRecords));
      const embedded = await embeddedEvidence(candidate.path);
      if (embedded) candidate.evidence.push(embedded);
      return candidate;
    }),
  );
  const enrichedCandidates = [];
  for (const [index, result] of enrichmentResults.entries()) {
    if (result.status === "fulfilled") {
      enrichedCandidates.push(result.value);
    } else {
      candidateFailures.push({
        directory: enrichmentCandidates[index].path,
        error: result.reason,
      });
    }
  }
  if (explicitDirectory) {
    for (const failure of candidateFailures) {
      const failureTarget = await realpath(failure.directory).catch(() =>
        path.resolve(failure.directory)
      );
      if (failureTarget === explicitTarget) throw failure.error;
    }
  }
  const candidateDiagnostics = [
    ...pluginDiagnostics,
    ...scanDiagnostics.filter(({ kind }) => kind !== "plugin"),
    ...candidateFailures.map(({ directory, error }) => ({
      path: path.resolve(directory),
      code: error?.code ?? "INVALID_DISCOVERY_CANDIDATE",
      message: error?.message ?? String(error),
    })),
  ];

  let selected = enrichedCandidates;
  if (input) {
    if (explicitDirectory) {
      selected = selected.filter(
        (candidate) =>
          path.resolve(candidate.realPath ?? candidate.path) === explicitTarget,
      );
    } else if (repositoryInput) {
      const locator = normalizeRepositoryLocator(input);
      selected = selected.filter((candidate) =>
        candidate.evidence.some(
          ({ repository, upstream_path: upstreamPath, upstreamPath: legacyUpstreamPath }) => {
            if (repository !== locator.repository) return false;
            if (!locator.subdir) return true;
            return normalizeUpstreamEntrypoint(upstreamPath ?? legacyUpstreamPath)
              === normalizeUpstreamEntrypoint(locator.subdir);
          },
        ),
      );
    } else if (filesystemInput.exists || /[/\\]/.test(input)) {
      selected = [];
    } else {
      selected = selected.filter(({ name }) => name === input);
    }
  }
  if (input && selected.length === 0) {
    const locator = repositoryInput
      ? normalizeRepositoryLocator(input)
      : undefined;
    const metadataMatches = managerRecords.filter(
      (record) =>
        !record.path &&
        (locator
          ? record.source?.repository === locator.repository
          : record.name === input),
    );
    throw new DiscoveryError(`no local copy found for ${input}`, {
      code: "NO_LOCAL_COPY",
      details: {
        input,
        metadataMatches,
        candidateDiagnostics,
        action: "install, clone, create, or choose a custom path",
      },
    });
  }
  const groups = groupCandidates(selected);
  return {
    groups,
    choices: [
      ...groups.map((group) => ({ kind: "skill", name: group.name, fingerprint: group.fingerprint })),
      { kind: "custom-path" },
    ],
    searchedRoots: normalizedRoots,
    managerDiagnostics,
    pluginDiagnostics,
    candidateDiagnostics,
    unresolvedManagerRecords: managerRecords.filter(({ path: managerPath }) => !managerPath),
  };
}

export function confirmDiscoverySelection({
  discovery,
  choice,
  interactive = false,
  confirmedProvenance,
  confirmationEvidence,
}) {
  if (!interactive) {
    throw new DiscoveryError("discovery selection requires interactive confirmation", {
      code: "DISCOVERY_CONFIRMATION_REQUIRED",
    });
  }
  const group = discovery.groups.find(
    (candidate) =>
      candidate.name === choice?.name &&
      candidate.fingerprint === choice?.fingerprint,
  );
  if (!group) {
    throw new DiscoveryError("discovery choice is not present in the current result", {
      code: "INVALID_DISCOVERY_CHOICE",
    });
  }
  const pathMatches = choice.path
    ? group.copies.filter(({ path: candidatePath }) => candidatePath === choice.path)
    : [];
  const copy = choice.path
    ? choice.owner
      ? pathMatches.find(({ owner, owners = [owner] }) =>
        owners.includes(choice.owner),
      )
      : pathMatches.length === 1
        ? pathMatches[0]
        : undefined
    : group.copies.length === 1
      ? group.copies[0]
      : undefined;
  if (!copy) {
    throw new DiscoveryError("choose one concrete copy and ownership path", {
      code: "DISCOVERY_COPY_REQUIRED",
      details: group.copies,
    });
  }
  if (
    copy.conflict
    && (!confirmedProvenance || !copy.provenance.includes(confirmedProvenance))
  ) {
    throw new DiscoveryError("conflicting provenance requires an explicit choice", {
      code: "PROVENANCE_CONFIRMATION_REQUIRED",
      details: copy.provenance,
    });
  }
  if (confirmedProvenance && !copy.provenance.includes(confirmedProvenance)) {
    throw new DiscoveryError("confirmed provenance does not belong to the selected copy", {
      code: "PROVENANCE_COPY_MISMATCH",
      details: { copy, confirmedProvenance },
    });
  }
  if (
    confirmationEvidence !== undefined
    && (
      !confirmationEvidence
      || typeof confirmationEvidence !== "object"
      || Array.isArray(confirmationEvidence)
      || Object.keys(confirmationEvidence).length === 0
    )
  ) {
    throw new DiscoveryError("confirmation evidence must be a non-empty object", {
      code: "INVALID_CONFIRMATION_EVIDENCE",
    });
  }
  return {
    name: group.name,
    fingerprint: group.fingerprint,
    copy,
    provenance: confirmedProvenance ?? copy.provenance[0],
    evidence: [
      ...copy.evidence,
      {
        kind: "confirmation",
        path: copy.path,
        ...(confirmedProvenance ? { provenance: confirmedProvenance } : {}),
        ...(confirmationEvidence
          ? { confirmationEvidence: structuredClone(confirmationEvidence) }
          : {}),
      },
    ],
  };
}

export function activeSkillInventory(discovery) {
  const skills = new Map();
  for (const group of discovery.groups) {
    for (const copy of group.copies) {
      const key = `${group.name}\0${copy.realPath ?? copy.path}`;
      if (!skills.has(key)) {
        skills.set(key, {
          name: group.name,
          path: copy.path,
          realPath: copy.realPath ?? copy.path,
        });
      }
    }
  }
  return [...skills.values()];
}

export async function excludeSkillRootFromInventory(activeSkills, skillRoot) {
  if (!Array.isArray(activeSkills)) return activeSkills;
  let excludedRoot;
  try {
    excludedRoot = await realpath(skillRoot);
  } catch {
    excludedRoot = path.resolve(skillRoot);
  }
  const included = await Promise.all(activeSkills.map(async (skill) => {
    const candidate = skill.realPath ?? skill.path;
    if (typeof candidate !== "string") return skill;
    try {
      return await realpath(candidate) === excludedRoot ? null : skill;
    } catch {
      return path.resolve(candidate) === excludedRoot ? null : skill;
    }
  }));
  return included.filter(Boolean);
}
