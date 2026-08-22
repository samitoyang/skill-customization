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
import { fingerprintPath } from "./fingerprint.js";
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
import {
  checkProvenance,
  confirmProvenanceDecision,
} from "./provenance.js";
import { isPathContained } from "./paths.js";
import {
  normalizeSkillRootObservations,
  registrySkillRoots,
} from "./skill-root-registry.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";
import { publishDiscoveryPerformanceMetric } from "./performance-diagnostics.js";

const execFile = promisify(execFileCallback);

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

function mergePluginRootPolicy(existing, normalized) {
  const pluginRecords = [existing, normalized].filter(
    ({ origin }) => origin === "plugin",
  );
  if (pluginRecords.length === 0) return;

  // Keep the first path/owner as the public copy, but apply plugin scan policy
  // whenever any observation identifies the physical root as plugin-backed.
  existing.origin = "plugin";
  existing.host ??= pluginRecords.find(({ host }) => host)?.host;
  existing.pluginManifest ??= pluginRecords.find(
    ({ pluginManifest }) => pluginManifest,
  )?.pluginManifest;

  const pluginRoots = [
    ...new Set(pluginRecords.flatMap((record) => [
      ...(record.pluginRoots ?? []),
      record.pluginRoot,
    ]).filter(Boolean).map((pluginRoot) => path.resolve(pluginRoot))),
  ];
  if (pluginRoots.length > 0) {
    existing.pluginRoots = pluginRoots;
    existing.pluginRoot ??= pluginRoots[0];
  }

  const singleSkillPolicies = pluginRecords
    .filter((record) => Object.hasOwn(record, "singleSkill"))
    .map(({ singleSkill }) => singleSkill);
  if (singleSkillPolicies.includes(true)) existing.singleSkill = true;
  else if (singleSkillPolicies.length > 0) existing.singleSkill = false;

  const rootSkillPolicies = pluginRecords
    .filter((record) => Object.hasOwn(record, "includeRootSkill"))
    .map(({ includeRootSkill }) => includeRootSkill);
  if (rootSkillPolicies.includes(false)) existing.includeRootSkill = false;
  else if (rootSkillPolicies.includes(true)) existing.includeRootSkill = true;
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
    // Audit-only cache observations stay inactive unless another root identifies
    // the same physical source as an active installation.
    if (normalized.active === true) {
      existing.active = true;
    } else if (existing.active === false && normalized.active !== false) {
      delete existing.active;
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
    // A standard root can be an alias for a plugin root; keep plugin context on
    // the public copy while pluginEvidence/pluginIdentities retain every observation.
    if (!existing.plugin && normalized.plugin) {
      existing.plugin = structuredClone(normalized.plugin);
    }
    if (!existing.pluginMetadata && normalized.pluginMetadata) {
      existing.pluginMetadata = structuredClone(normalized.pluginMetadata);
    }
    if (!existing.pluginIdentity && normalized.pluginIdentity) {
      existing.pluginIdentity = normalized.pluginIdentity;
    }
    mergePluginRootPolicy(existing, normalized);
  }
  return [...byPath.values()];
}

async function uniquePhysicalRoots(roots) {
  const byPhysicalPath = new Map();
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
    const physicalPath = normalized.physicalPath
      ?? await realpath(normalized.path).catch(() => normalized.path);
    const existing = byPhysicalPath.get(physicalPath);
    if (!existing) {
      byPhysicalPath.set(physicalPath, { ...normalized, physicalPath });
      continue;
    }
    const [merged] = uniqueRoots([
      existing,
      {
        ...normalized,
        // Retain the standard-facing alias while uniqueRoots promotes any
        // plugin containment and scan policy attached to the physical source.
        path: existing.path,
        aliases: [
          ...(existing.aliases ?? [existing.path]),
          ...(normalized.aliases ?? [normalized.path]),
        ],
      },
    ]);
    byPhysicalPath.set(physicalPath, { ...merged, physicalPath });
  }
  return [...byPhysicalPath.values()];
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

/**
 * Collect host standard and configured root observations and normalize them
 * through the Skill root registry.
 *
 * @returns {{readonly roots: readonly object[], readonly diagnostics: readonly object[]}}
 */
export function hostSkillRootRegistry({
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
      {
        kind: "configured",
        path: path.basename(directory) === "skills"
          ? directory
          : path.join(directory, ".claude", "skills"),
        owner: "claude-additional",
        scope: "workspace",
        origin: "host-added",
      },
    );
  }
  for (const directory of (env.COPILOT_SKILLS_DIRS ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    roots.push({
      kind: "configured",
      path: directory,
      owner: "copilot-env",
      scope: "workspace",
      origin: "host-added",
    });
  }
  return normalizeSkillRootObservations(roots);
}

/**
 * Compatibility array interface for callers that only need host roots.
 *
 * @returns {readonly object[]}
 */
export function hostSkillRoots(options = {}) {
  return hostSkillRootRegistry(options).roots;
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
  const rootRegistry = hostSkillRootRegistry({
      home,
      cwd,
      env,
      claudeSettings: { additionalDirectories: [...new Set(additionalDirectories)] },
    });
  return {
    roots: rootRegistry.roots,
    rootDiagnostics: rootRegistry.diagnostics,
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
  publishDiscoveryPerformanceMetric("root_scans");
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
  const canonicalPluginRoots = (
    await Promise.all(
      [...new Set([
        ...(rootInfo.pluginRoots ?? []),
        rootInfo.pluginRoot,
      ].filter(Boolean))].map((pluginRoot) =>
        realpath(pluginRoot).catch(() => undefined),
      ),
    )
  ).filter(Boolean);
  const isContainedPluginDirectory = async (directory) => {
    if (canonicalPluginRoots.length === 0 || rootInfo.origin !== "plugin") return true;
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (
      !canonicalDirectory
      || canonicalPluginRoots.every((pluginRoot) =>
        isPathContained(pluginRoot, canonicalDirectory),
      )
    ) return true;
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
    ...(rootInfo.active === false ? { active: false } : {}),
    fingerprint: customization?.owned_payload.reviewed_fingerprint
      ?? await fingerprintPath(directory),
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
    const copyDecision = checkProvenance({ observations: candidate.evidence });
    const copy = {
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
      evidence: [...copyDecision.evidence],
      provenance: [...copyDecision.provenance],
      conflict: copyDecision.conflict,
      classification: candidate.classification,
      ...(candidate.active === false ? { active: false } : {}),
      ...(candidate.customization
        ? { customization: structuredClone(candidate.customization) }
        : {}),
    };
    Object.defineProperty(copy, "provenanceDecision", {
      value: copyDecision,
      enumerable: false,
      writable: false,
    });
    group.copies.push(copy);
    group.evidence.push(...candidate.evidence);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const decision = checkProvenance({ observations: group.evidence });
    group.evidence = [...decision.evidence];
    group.provenance = [...decision.provenance];
    group.conflict = decision.conflict;
    Object.defineProperty(group, "provenanceDecision", {
      value: decision,
      enumerable: false,
      writable: false,
    });
  }
  const result = [...groups.values()];
  const nameCounts = new Map();
  for (const group of result) nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  for (const group of result) group.nameCollision = nameCounts.get(group.name) > 1;
  return result.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function candidateMatchesRepository(candidate, locator) {
  const decision = checkProvenance({ observations: candidate.evidence });
  const repositoryIdentity = `repository:${locator.repository}`;
  const hasRepositoryIdentity = () => {
    if (!locator.subdir) {
      return decision.provenance.some((identity) =>
        identity === repositoryIdentity
        || identity.startsWith(`${repositoryIdentity}#`),
      );
    }
    const upstreamPath = normalizeUpstreamEntrypoint(locator.subdir);
    return decision.provenance.includes(
      `${repositoryIdentity}#${upstreamPath}`,
    );
  };
  // Keep conflicting repository copies visible so confirmation can choose one;
  // malformed or otherwise ineligible evidence is filtered at this seam.
  if (!decision.selectionEligible && !decision.conflict) return false;
  return hasRepositoryIdentity();
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
  rootDiagnostics: suppliedRootDiagnostics = [],
} = {}) {
  publishDiscoveryPerformanceMetric("discovery_calls");
  let managerDiagnostics = [];
  const rootDiagnostics = [...suppliedRootDiagnostics];
  if (managerRecords === undefined) {
    publishDiscoveryPerformanceMetric("manager_collections");
    const collected = await managerCollector({ home, cwd, env, ...managerOptions });
    managerRecords = collected.records;
    managerDiagnostics = collected.diagnostics;
  }
  const rootsAreExplicit = roots !== undefined;
  // An omitted roots option is the ambient mode; an explicit empty array is intentionally deterministic.
  let pluginRoots = [];
  let pluginDiagnostics = [];
  if (!rootsAreExplicit && includePlugins !== false) {
    publishDiscoveryPerformanceMetric("plugin_discovery_calls");
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
  let ambientRoots = roots;
  if (!rootsAreExplicit) {
    const hostRegistry = hostSkillRootRegistry({ home, cwd, env });
    ambientRoots = hostRegistry.roots;
    rootDiagnostics.push(...hostRegistry.diagnostics);
  }
  const declaredRoots = [
    ...ambientRoots,
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
      publishDiscoveryPerformanceMetric("git_probes");
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
      selected = selected.filter((candidate) => candidateMatchesRepository(candidate, locator));
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
    rootDiagnostics,
    managerDiagnostics,
    pluginDiagnostics,
    candidateDiagnostics,
    unresolvedManagerRecords: managerRecords.filter(({ path: managerPath }) => !managerPath),
  };
}

/**
 * Create a request-scoped discovery snapshot for one operation.
 *
 * The inventory is intentionally not process-global. Callers that already
 * discovered the host can seed the snapshot; otherwise the first inventory
 * request performs one discovery call. Targeted queries are memoized only for
 * this operation, so repeated checks observe one consistent input set.
 */
export function createDiscoverySnapshot({
  discovery,
  roots,
  managerRecords = [],
  options = {},
  discover = discoverSkills,
} = {}) {
  if (discovery !== undefined && (!discovery || typeof discovery !== "object")) {
    throw new TypeError("discovery snapshot seed must be an object");
  }
  if (typeof discover !== "function") {
    throw new TypeError("discovery snapshot adapter must be a function");
  }
  const defaults = {
    ...options,
    ...(roots === undefined ? {} : { roots }),
    managerRecords,
  };
  let inventoryPromise = discovery === undefined
    ? undefined
    : Promise.resolve(discovery);
  const targeted = new Map();

  async function inventory() {
    inventoryPromise ??= discover(defaults);
    return inventoryPromise;
  }

  async function discoverTarget({ input } = {}) {
    if (input === undefined) return inventory();
    const key = JSON.stringify(input);
    if (!targeted.has(key)) {
      targeted.set(key, discover({ ...defaults, input }));
    }
    return targeted.get(key);
  }

  return Object.freeze({ inventory, discover: discoverTarget });
}

/**
 * Select one source directory from an inventory without rescanning its roots.
 * Explicit evidence is added because a source-path discovery has historically
 * marked that concrete path as an explicit observation.
 */
export function selectDiscoverySource(
  discovery,
  { sourceRoot, explicitInput } = {},
) {
  if (!discovery || !Array.isArray(discovery.groups)) return undefined;
  const canonicalSource = path.resolve(sourceRoot);
  const groups = discovery.groups.flatMap((group) => {
    const copies = group.copies.filter((copy) =>
      path.resolve(copy.realPath ?? copy.path) === canonicalSource,
    );
    if (copies.length === 0) return [];
    const explicitPath = path.resolve(explicitInput ?? sourceRoot);
    return groupCandidates(
      copies.map((copy) => ({
        ...copy,
        name: group.name,
        fingerprint: group.fingerprint,
        evidence: [
          ...(copy.evidence ?? []),
          { kind: "explicit", path: explicitPath },
        ],
      })),
    );
  });
  return groups[0];
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
  const baseDecision = copy.provenanceDecision
    ?? checkProvenance({ observations: copy.evidence });
  const provenanceDecision = confirmProvenanceDecision(baseDecision, {
    path: copy.path,
    ...(confirmedProvenance ? { provenance: confirmedProvenance } : {}),
    ...(confirmationEvidence !== undefined ? { evidence: confirmationEvidence } : {}),
  });
  const diagnostic = provenanceDecision.diagnostics[0];
  if (diagnostic?.code === "PROVENANCE_CONFIRMATION_REQUIRED") {
    throw new DiscoveryError("conflicting provenance requires an explicit choice", {
      code: "PROVENANCE_CONFIRMATION_REQUIRED",
      details: copy.provenance,
    });
  }
  if (diagnostic?.code === "PROVENANCE_CONFIRMATION_MISMATCH") {
    throw new DiscoveryError("confirmed provenance does not belong to the selected copy", {
      code: "PROVENANCE_COPY_MISMATCH",
      details: { copy, confirmedProvenance },
    });
  }
  if (diagnostic?.code === "INVALID_CONFIRMATION_EVIDENCE") {
    throw new DiscoveryError("confirmation evidence must be a non-empty object", {
      code: "INVALID_CONFIRMATION_EVIDENCE",
    });
  }
  if (!provenanceDecision.selectionEligible) {
    throw new DiscoveryError("invalid provenance evidence", {
      code: "INVALID_PROVENANCE_EVIDENCE",
      details: provenanceDecision.diagnostics,
    });
  }
  return {
    name: group.name,
    fingerprint: group.fingerprint,
    copy,
    provenance: provenanceDecision.selectedProvenance,
    evidence: [...provenanceDecision.evidence],
  };
}

export function activeSkillInventory(discovery) {
  const skills = new Map();
  for (const group of discovery.groups) {
    for (const copy of group.copies) {
      if (copy.active === false) continue;
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
