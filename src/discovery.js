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

import { ingestDescriptor } from "./descriptor.js";
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
  stableProvenanceKey,
} from "./provenance.js";
import { isPathContained } from "./paths.js";
import {
  normalizeSkillRootObservations,
  registrySkillRoots,
  skillRootObservation,
} from "./skill-root-registry.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";
import { publishDiscoveryPerformanceMetric } from "./performance-diagnostics.js";

const execFile = promisify(execFileCallback);

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
 * Build host standard and configured root observations for the request-scoped
 * registry pass owned by Discovery.
 *
 * @returns {object[]}
 */
function hostSkillRootObservations({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
  claudeSettings = {},
  includeStandard = true,
} = {}) {
  const workspaceDirectories = boundedWorkspaceDirectories({ cwd, home });
  const resolvedCwd = path.resolve(cwd);
  const roots = includeStandard
    ? registrySkillRoots({
        home,
        env,
        workspaceDirectories: workspaceDirectories.map((directory) => ({
          path: directory,
          origin: directory === resolvedCwd ? "project" : "ancestor",
        })),
      })
    : [];
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
  return roots;
}

/**
 * Collect host standard and configured root observations and normalize them
 * through the Skill root registry.
 *
 * @returns {{readonly roots: readonly object[], readonly diagnostics: readonly object[]}}
 */
export function hostSkillRootRegistry(options = {}) {
  return normalizeSkillRootObservations(hostSkillRootObservations(options));
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
  const settingsControlPaths = [...candidates.keys()].sort((left, right) =>
    left.localeCompare(right, "en"));
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
  const rootObservations = hostSkillRootObservations({
    home,
    cwd,
    env,
    claudeSettings: { additionalDirectories: [...new Set(additionalDirectories)] },
    includeStandard: false,
  });
  const rootRegistry = normalizeSkillRootObservations(rootObservations);
  return {
    roots: rootRegistry.roots,
    rootObservations,
    rootDiagnostics: rootRegistry.diagnostics,
    settingsEvidence,
    settingsControlPaths,
    diagnostics,
  };
}

async function exists(target) {
  return access(target).then(
    () => true,
    () => false,
  );
}

async function hasDiscoverableSkill(directory) {
  const [skillEntrypoint, descriptor] = await Promise.all([
    exists(path.join(directory, "SKILL.md")),
    exists(path.join(directory, "customization.json")),
  ]);
  return skillEntrypoint || descriptor;
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
    (await hasDiscoverableSkill(resolved))
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
    && await hasDiscoverableSkill(rootInfo.path)
  ) directories.push(rootInfo.path);
  if (!rootInfo.singleSkill) {
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const directory = path.join(rootInfo.path, entry.name);
        if (
          await hasDiscoverableSkill(directory)
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
    publishDiscoveryPerformanceMetric("git_probes");
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
  const result = await ingestDescriptor({ descriptorPath });
  if (result.ok) return result.checked.descriptor;

  const first = result.diagnostics[0];
  if (first?.stage === "read" && first.causeCode === "ENOENT") return undefined;
  if (first?.stage === "parse") {
    throw new DiscoveryError(
      `malformed customization metadata ${descriptorPath}: ${first.causeMessage ?? first.message}`,
      { code: "MALFORMED_CUSTOMIZATION_METADATA", details: first.details },
    );
  }
  if (first?.stage === "read" || first?.artifactKind === "descriptor") {
    throw new DiscoveryError(
      `cannot read adjacent customization metadata ${descriptorPath}: ${first.causeMessage ?? first.message}`,
      { code: "MALFORMED_CUSTOMIZATION_METADATA", details: first.details },
    );
  }
  throw new DiscoveryError(`invalid customization metadata ${descriptorPath}`, {
    code: "MALFORMED_CUSTOMIZATION_METADATA",
    details: first?.details ?? result.diagnostics,
  });
}

async function candidateFromDirectory(directory, rootInfo) {
  const realDirectory = await realpath(directory).catch(() => path.resolve(directory));
  const customization = await adjacentCustomization(realDirectory);
  const entrypoint = path.join(
    directory,
    customization?.entrypoint ?? "SKILL.md",
  );
  const markdown = await readFile(entrypoint, "utf8");
  return {
    name: customization?.name
      ?? parseSkillMetadata(markdown).name
      ?? path.basename(directory),
    path: path.resolve(directory),
    realPath: realDirectory,
    entrypoint,
    rootAliases: [...(rootInfo.aliases ?? [rootInfo.path])],
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
  const candidatePaths = new Set([
    candidate.path,
    candidate.realPath,
    candidate.entrypoint,
    ...(candidate.rootAliases ?? []),
  ]);
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
  managerDiagnostics: suppliedManagerDiagnostics = [],
  settingsEvidence: suppliedSettingsEvidence = [],
  settingsControlPaths: suppliedSettingsControlPaths = [],
  managerOptions,
  managerCollector = collectManagerRecords,
  customPath,
  rootDiagnostics: suppliedRootDiagnostics = [],
} = {}) {
  publishDiscoveryPerformanceMetric("discovery_calls");
  let managerDiagnostics = [...suppliedManagerDiagnostics];
  const rootDiagnostics = [...suppliedRootDiagnostics];
  if (managerRecords === undefined) {
    publishDiscoveryPerformanceMetric("manager_collections");
    const collected = await managerCollector({ home, cwd, env, ...managerOptions });
    managerRecords = collected.records;
    managerDiagnostics.push(...collected.diagnostics);
  }
  const rootsAreExplicit = roots !== undefined;
  // An omitted roots option is the ambient mode; an explicit empty array is intentionally deterministic.
  let pluginRoots = [];
  let pluginDiagnostics = [];
  let pluginControlPaths = [];
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
    pluginControlPaths = plugins.controlPaths ?? [];
  }
  // Manager records and customPath are explicit evidence sources; roots controls ambient host/plugin roots.
  let ambientRootObservations = roots;
  if (!rootsAreExplicit) {
    ambientRootObservations = hostSkillRootObservations({ home, cwd, env });
  }
  const rootObservations = [
    ...(ambientRootObservations ?? []).map((item) =>
      skillRootObservation(item, "explicit")),
    ...(rootsAreExplicit ? [] : additionalRoots).map((item) =>
      skillRootObservation(item, "configured")),
    ...pluginRoots.map((item) => skillRootObservation(item, "plugin")),
    ...managerSkillRoots(managerRecords).map((item) =>
      skillRootObservation(item, "manager")),
    ...(customPath
      ? [skillRootObservation({ path: customPath }, "explicit")]
      : []),
  ];
  const filesystemInput = input
    ? await inspectFilesystemInput(input, cwd)
    : { exists: false };
  const explicitDirectory = filesystemInput.skillDirectory;
  const repositoryInput = Boolean(
    input && !filesystemInput.exists && isRepositoryLocator(input),
  );
  if (explicitDirectory) {
    rootObservations.push(
      skillRootObservation({
        path: explicitDirectory,
        owner: "explicit",
        scope: "custom",
        origin: "custom-path",
      }, "explicit"),
    );
  }
  const rootRegistry = normalizeSkillRootObservations(rootObservations);
  rootDiagnostics.push(...rootRegistry.diagnostics);
  // Keep the historical mutable result surface, but copy only after the
  // registry has completed all root identity and policy decisions.
  const normalizedRoots = rootRegistry.roots.map((record) => structuredClone(record));
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
  const managerControlPaths = [...new Set([
    ...managerRecords.map(({ controlPath }) => controlPath),
    ...managerDiagnostics.map(({ source }) => source),
  ].filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate))
    .map((candidate) => path.resolve(candidate)))].sort((left, right) =>
    left.localeCompare(right, "en"));
  const settingsEvidence = suppliedSettingsEvidence.map((evidence) => ({
    ...evidence,
  }));
  const settingsControlPaths = [...new Set(
    [
      ...suppliedSettingsControlPaths,
      ...settingsEvidence.map(({ file }) => file),
    ]
      .filter((candidate) => typeof candidate === "string" && path.isAbsolute(candidate))
      .map((candidate) => path.resolve(candidate)),
  )].sort((left, right) => left.localeCompare(right, "en"));
  return {
    groups,
    choices: [
      ...groups.map((group) => ({ kind: "skill", name: group.name, fingerprint: group.fingerprint })),
      { kind: "custom-path" },
    ],
    searchedRoots: normalizedRoots,
    rootDiagnostics,
    managerDiagnostics,
    managerControlPaths,
    settingsEvidence,
    settingsControlPaths,
    pluginDiagnostics,
    pluginControlPaths,
    candidateDiagnostics,
    unresolvedManagerRecords: managerRecords.filter(({ path: managerPath }) => !managerPath),
  };
}

/**
 * Create a request-scoped Discovery snapshot for one operation.
 *
 * The optional seed lets a caller reuse a Discovery result it already owns.
 * Inventory and targeted lookups are memoized only for this operation; a new
 * snapshot therefore observes changed roots, evidence, and source content.
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
  const seededRoots = roots ?? options.roots ?? discovery?.searchedRoots;
  const {
    pluginControlPaths: optionPluginControlPaths = [],
    managerControlPaths: optionManagerControlPaths = [],
    settingsControlPaths: optionSettingsControlPaths = [],
    ...discoveryOptions
  } = options;
  const seedControlPaths = (...sources) => [...new Set(
    sources.flatMap((source) => Array.isArray(source) ? source : []),
  )].sort((left, right) => left.localeCompare(right, "en"));
  const seededPluginControlPaths = seedControlPaths(
    discovery?.pluginControlPaths,
    optionPluginControlPaths,
  );
  const seededManagerControlPaths = seedControlPaths(
    discovery?.managerControlPaths,
    optionManagerControlPaths,
  );
  const seededSettingsControlPaths = seedControlPaths(
    discovery?.settingsControlPaths,
    optionSettingsControlPaths,
  );
  const defaults = {
    ...discoveryOptions,
    ...(seededRoots === undefined ? {} : { roots: seededRoots }),
    managerRecords,
  };
  const targeted = new Map();
  const mergedControlPaths = (seeded, current) => [...new Set([
    ...seeded,
    ...(Array.isArray(current) ? current : []),
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const controlPathsMatch = (current, merged) => (
    (current === undefined && merged.length === 0)
    || (Array.isArray(current)
      && current.length === merged.length
      && current.every((value, index) => value === merged[index]))
  );

  const attachControlPaths = (result) => {
    const pluginControlPaths = mergedControlPaths(
      seededPluginControlPaths,
      result.pluginControlPaths,
    );
    const managerControlPaths = mergedControlPaths(
      seededManagerControlPaths,
      result.managerControlPaths,
    );
    const settingsControlPaths = mergedControlPaths(
      seededSettingsControlPaths,
      result.settingsControlPaths,
    );
    if (
      controlPathsMatch(result.pluginControlPaths, pluginControlPaths)
      && controlPathsMatch(result.managerControlPaths, managerControlPaths)
      && controlPathsMatch(result.settingsControlPaths, settingsControlPaths)
    ) return result;
    return {
      ...result,
      pluginControlPaths,
      managerControlPaths,
      settingsControlPaths,
    };
  };

  let inventoryPromise = discovery === undefined
    ? undefined
    : Promise.resolve(discovery).then(attachControlPaths);

  async function inventory() {
    inventoryPromise ??= discover(defaults).then(attachControlPaths);
    return inventoryPromise;
  }

  async function discoverTarget({ input } = {}) {
    if (input === undefined) return inventory();
    const key = JSON.stringify(input);
    if (!targeted.has(key)) {
      targeted.set(key, discover({ ...defaults, input }).then(attachControlPaths));
    }
    return targeted.get(key);
  }

  async function revision() {
    // Read only promises already memoized by this request; never start a new
    // inventory or targeted Discovery operation while comparing evidence.
    const targetedResults = await Promise.all(
      [...targeted.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(async ([key, promise]) => {
          try {
            return [key, await promise];
          } catch (error) {
            // A targeted miss is an intentional, memoized result.  Consumers
            // such as replacement activation may treat it as an empty
            // inventory, so observing the snapshot revision must not replay
            // the rejection as a different outcome.
            if (error?.code === "NO_LOCAL_COPY") {
              return [key, { status: "no-local-copy" }];
            }
            throw error;
          }
        }),
    );
    return stableProvenanceKey({
      defaults,
      ...(inventoryPromise ? { inventory: await inventoryPromise } : {}),
      targeted: targetedResults,
    });
  }

  return Object.freeze({ inventory, discover: discoverTarget, revision });
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
