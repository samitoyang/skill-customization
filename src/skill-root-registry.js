import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_ROOT_REGISTRY_CHECKPOINT = Object.freeze({
  repository: "https://github.com/vercel-labs/skills",
  revision: "305ff8be68e59368789d765e2cf0edfab851c453",
  file: "src/agents.ts",
});

/** @typedef {import("./provenance.js").PluginProvenanceObservation} PluginProvenanceObservation */
/** @typedef {Record<string, unknown>} PluginRootMetadata */

/**
 * @typedef {object} StandardSkillRootObservation
 * @property {"standard"} kind
 * @property {string} path
 * @property {string} owner
 * @property {"workspace" | "global"} scope
 * @property {string} origin
 * @property {readonly string[]} [aliases]
 * @property {readonly string[]} [owners]
 * @property {string} [registry]
 * @property {boolean} [active]
 * @property {boolean} [singleSkill]
 * @property {boolean} [includeRootSkill]
 */

/**
 * @typedef {object} ConfiguredSkillRootObservation
 * @property {"configured"} kind
 * @property {string} path
 * @property {string} owner
 * @property {"workspace" | "global" | "custom"} scope
 * @property {string} origin
 * @property {readonly string[]} [aliases]
 * @property {readonly string[]} [owners]
 * @property {boolean} [active]
 * @property {boolean} [singleSkill]
 * @property {boolean} [includeRootSkill]
 */

/**
 * @typedef {object} LaterSkillRootObservation
 * @property {"explicit" | "manager" | "plugin"} kind
 * @property {string} path
 * @property {string} owner
 * @property {readonly string[]} [aliases]
 * @property {readonly string[]} [owners]
 * @property {string} scope
 * @property {string} origin
 * @property {boolean} [active]
 * @property {boolean} [singleSkill]
 * @property {boolean} [includeRootSkill]
 * @property {string} [host]
 * @property {PluginRootMetadata} [plugin]
 * @property {PluginRootMetadata} [pluginMetadata]
 * @property {string} [pluginManifest]
 * @property {string} [pluginRoot]
 * @property {readonly string[]} [pluginRoots]
 * @property {string} [pluginIdentity]
 * @property {readonly string[]} [pluginIdentities]
 * @property {readonly PluginProvenanceObservation[]} [pluginEvidence]
 */

/**
 * @typedef {StandardSkillRootObservation | ConfiguredSkillRootObservation | LaterSkillRootObservation} SkillRootObservation
 */

/**
 * @typedef {object} SkillRootScanRecord
 * @property {string} path
 * @property {string} physicalPath
 * @property {readonly string[]} aliases
 * @property {string} owner
 * @property {readonly string[]} owners
 * @property {string} scope
 * @property {readonly string[]} [scopes]
 * @property {string} origin
 * @property {boolean} [active]
 * @property {string} [registry]
 * @property {readonly string[]} [registries]
 * @property {boolean} [singleSkill]
 * @property {boolean} [includeRootSkill]
 * @property {string} [host]
 * @property {PluginRootMetadata} [plugin]
 * @property {PluginRootMetadata} [pluginMetadata]
 * @property {string} [pluginManifest]
 * @property {string} [pluginRoot]
 * @property {readonly string[]} [pluginRoots]
 * @property {string} [pluginIdentity]
 * @property {readonly string[]} [pluginIdentities]
 * @property {readonly PluginProvenanceObservation[]} [pluginEvidence]
 */

/**
 * @typedef {object} SkillRootDiagnostic
 * @property {string} code
 * @property {string} message
 * @property {number} observationIndex
 */

const VERCEL_AGENT_ROOTS = [
  ["amp", ".agents/skills", ["xdg-config", "agents/skills"]],
  ["antigravity", ".agent/skills", ["home", ".gemini/antigravity/skills"]],
  ["augment", ".augment/skills", ["home", ".augment/skills"]],
  ["claude-code", ".claude/skills", ["claude-home", "skills"]],
  ["openclaw", "skills", ["openclaw-home", "skills"]],
  ["cline", ".cline/skills", ["home", ".cline/skills"]],
  ["codebuddy", ".codebuddy/skills", ["home", ".codebuddy/skills"]],
  ["codex", ".agents/skills", ["codex-home", "skills"]],
  ["command-code", ".commandcode/skills", ["home", ".commandcode/skills"]],
  ["continue", ".continue/skills", ["home", ".continue/skills"]],
  ["cortex", ".cortex/skills", ["home", ".snowflake/cortex/skills"]],
  ["crush", ".crush/skills", ["home", ".config/crush/skills"]],
  ["cursor", ".agents/skills", ["home", ".cursor/skills"]],
  ["droid", ".factory/skills", ["home", ".factory/skills"]],
  ["gemini-cli", ".agents/skills", ["home", ".gemini/skills"]],
  ["github-copilot", ".agents/skills", ["home", ".copilot/skills"]],
  ["goose", ".goose/skills", ["xdg-config", "goose/skills"]],
  ["junie", ".junie/skills", ["home", ".junie/skills"]],
  ["iflow-cli", ".iflow/skills", ["home", ".iflow/skills"]],
  ["kilo", ".kilocode/skills", ["home", ".kilocode/skills"]],
  ["kimi-cli", ".agents/skills", ["home", ".config/agents/skills"]],
  ["kiro-cli", ".kiro/skills", ["home", ".kiro/skills"]],
  ["kode", ".kode/skills", ["home", ".kode/skills"]],
  ["mcpjam", ".mcpjam/skills", ["home", ".mcpjam/skills"]],
  ["mistral-vibe", ".vibe/skills", ["home", ".vibe/skills"]],
  ["mux", ".mux/skills", ["home", ".mux/skills"]],
  ["opencode", ".agents/skills", ["xdg-config", "opencode/skills"]],
  ["openhands", ".openhands/skills", ["home", ".openhands/skills"]],
  ["pi", ".pi/skills", ["home", ".pi/agent/skills"]],
  ["qoder", ".qoder/skills", ["home", ".qoder/skills"]],
  ["qwen-code", ".qwen/skills", ["home", ".qwen/skills"]],
  ["replit", ".agents/skills", ["xdg-config", "agents/skills"]],
  ["roo", ".roo/skills", ["home", ".roo/skills"]],
  ["trae", ".trae/skills", ["home", ".trae/skills"]],
  ["trae-cn", ".trae/skills", ["home", ".trae-cn/skills"]],
  ["windsurf", ".windsurf/skills", ["home", ".codeium/windsurf/skills"]],
  ["zencoder", ".zencoder/skills", ["home", ".zencoder/skills"]],
  ["neovate", ".neovate/skills", ["home", ".neovate/skills"]],
  ["pochi", ".pochi/skills", ["home", ".pochi/skills"]],
  ["adal", ".adal/skills", ["home", ".adal/skills"]],
  ["universal", ".agents/skills", ["xdg-config", "agents/skills"]],
].map(([owner, project, global]) =>
  Object.freeze({ owner, project, global: Object.freeze(global) }),
);

const LEGACY_ROOTS = [
  ["codex", ".codex/skills", ["codex-home", "skills"]],
  ["agents", ".agents/skills", ["home", ".agents/skills"]],
  ["claude", ".claude/skills", ["claude-home", "skills"]],
  ["copilot", ".github/skills", ["home", ".copilot/skills"]],
  ["cursor", ".cursor/skills", null],
].map(([owner, project, global]) =>
  Object.freeze({
    owner,
    project,
    global: global ? Object.freeze(global) : null,
    legacy: true,
  }),
);

export const SKILL_ROOT_REGISTRY = Object.freeze([
  ...LEGACY_ROOTS,
  ...VERCEL_AGENT_ROOTS,
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function rootDiagnostic(code, message, observationIndex) {
  return { code, message, observationIndex };
}

function canonicalRootPath(rootPath) {
  try {
    return path.resolve(realpathSync(rootPath));
  } catch {
    return path.resolve(rootPath);
  }
}

function normalizedString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

/**
 * Adapt one caller-facing root value into a typed registry observation.
 *
 * Root identity and policy are resolved by normalizeSkillRootObservations;
 * this boundary only supplies the source kind and compatibility defaults for
 * callers that still accept a path string.
 *
 * @param {unknown} item
 * @param {"standard" | "configured" | "explicit" | "manager" | "plugin"} kind
 * @param {{owner?: string, scope?: string, origin?: string}} [defaults]
 * @returns {Record<string, unknown>}
 */
export function skillRootObservation(item, kind, defaults = {}) {
  if (typeof item === "string") {
    return {
      kind,
      path: item,
      owner: defaults.owner ?? "custom",
      scope: defaults.scope ?? "custom",
      origin: defaults.origin ?? defaults.owner ?? "custom",
    };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { kind, path: item };
  }
  return {
    ...item,
    kind: item.kind ?? kind,
    owner: item.owner ?? defaults.owner ?? "custom",
    scope: item.scope ?? defaults.scope ?? "custom",
    origin: item.origin ?? defaults.origin ?? item.owner ?? "custom",
  };
}

function normalizeRootObservation(observation, diagnostics, observationIndex) {
  if (!isRecord(observation)) {
    diagnostics.push(rootDiagnostic(
      "MALFORMED_ROOT_OBSERVATION",
      "skill root observation must be an object",
      observationIndex,
    ));
    return undefined;
  }
  if (![
    "standard",
    "configured",
    "explicit",
    "manager",
    "plugin",
  ].includes(observation.kind)) {
    diagnostics.push(rootDiagnostic(
      "UNKNOWN_ROOT_OBSERVATION_KIND",
      `unsupported skill root observation kind: ${String(observation.kind)}`,
      observationIndex,
    ));
    return undefined;
  }
  const rootPath = normalizedString(observation.path);
  if (!rootPath) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_PATH",
      "skill root observation requires a non-empty path",
      observationIndex,
    ));
    return undefined;
  }
  const owner = normalizedString(observation.owner);
  if (!owner) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_OWNER",
      "skill root observation requires a non-empty owner",
      observationIndex,
    ));
    return undefined;
  }
  const scope = normalizedString(observation.scope);
  if (!scope) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_SCOPE",
      "skill root observation requires a non-empty scope",
      observationIndex,
    ));
    return undefined;
  }
  const origin = normalizedString(observation.origin);
  if (!origin) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_ORIGIN",
      "skill root observation requires a non-empty origin",
      observationIndex,
    ));
    return undefined;
  }
  for (const field of ["active", "singleSkill", "includeRootSkill"]) {
    if (observation[field] !== undefined && typeof observation[field] !== "boolean") {
      diagnostics.push(rootDiagnostic(
        "INVALID_ROOT_POLICY",
        `skill root ${field} policy must be boolean`,
        observationIndex,
      ));
      return undefined;
    }
  }
  if (
    observation.aliases !== undefined
    && (!Array.isArray(observation.aliases)
      || observation.aliases.some((alias) => !normalizedString(alias)))
  ) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_ALIASES",
      "skill root aliases must be non-empty strings",
      observationIndex,
    ));
    return undefined;
  }
  if (
    observation.owners !== undefined
    && (!Array.isArray(observation.owners)
      || observation.owners.some((candidate) => !normalizedString(candidate)))
  ) {
    diagnostics.push(rootDiagnostic(
      "INVALID_ROOT_OWNERS",
      "skill root owners must be non-empty strings",
      observationIndex,
    ));
    return undefined;
  }
  let normalized;
  try {
    normalized = structuredClone(observation);
  } catch {
    diagnostics.push(rootDiagnostic(
      "MALFORMED_ROOT_OBSERVATION",
      "skill root observation must contain cloneable record values",
      observationIndex,
    ));
    return undefined;
  }
  const lexicalPath = path.resolve(rootPath);
  normalized.path = lexicalPath;
  normalized.physicalPath = canonicalRootPath(lexicalPath);
  normalized.aliases = unique([
    lexicalPath,
    ...(observation.aliases ?? []).map((alias) => path.resolve(alias)),
  ]);
  normalized.owner = owner;
  normalized.owners = unique([
    owner,
    ...(observation.owners ?? []).map((candidate) => candidate.trim()),
  ]);
  normalized.scope = scope;
  normalized.origin = origin;
  if (observation.kind === "standard" || observation.kind === "configured") {
    normalized.active ??= true;
    normalized.singleSkill ??= false;
    normalized.includeRootSkill ??= true;
  }
  delete normalized.kind;
  return normalized;
}

function mergeBooleanPolicy(existing, incoming, field, preferredValue) {
  const values = [existing, incoming]
    .filter((record) => Object.hasOwn(record, field))
    .map((record) => record[field]);
  if (values.includes(preferredValue)) {
    existing[field] = preferredValue;
  } else if (values.length > 0) {
    existing[field] = values[0];
  }
}

function mergeFirstDefined(existing, incoming, field) {
  if (existing[field] === undefined && incoming[field] !== undefined) {
    existing[field] = structuredClone(incoming[field]);
  }
}

function mergeStructuredArray(existing, incoming, field) {
  const values = [];
  const seen = new Set();
  for (const value of [
    ...(Array.isArray(existing[field]) ? existing[field] : []),
    ...(Array.isArray(incoming[field]) ? incoming[field] : []),
  ]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(structuredClone(value));
  }
  if (values.length > 0) existing[field] = values;
}

function mergePluginMetadata(existing, incoming) {
  for (const field of [
    "host",
    "plugin",
    "pluginMetadata",
    "pluginManifest",
  ]) {
    mergeFirstDefined(existing, incoming, field);
  }

  const pluginRoots = unique([
    ...(existing.pluginRoots ?? []),
    existing.pluginRoot,
    ...(incoming.pluginRoots ?? []),
    incoming.pluginRoot,
  ].filter(Boolean).map((pluginRoot) => path.resolve(pluginRoot)));
  if (pluginRoots.length > 0) {
    existing.pluginRoots = pluginRoots;
    existing.pluginRoot ??= pluginRoots[0];
  }

  mergeStructuredArray(existing, incoming, "pluginEvidence");
  const pluginIdentities = unique([
    ...(existing.pluginIdentities ?? []),
    existing.pluginIdentity,
    ...(incoming.pluginIdentities ?? []),
    incoming.pluginIdentity,
  ].filter(Boolean));
  if (pluginIdentities.length > 0) existing.pluginIdentities = pluginIdentities;
  mergeFirstDefined(existing, incoming, "pluginIdentity");
}

function mergeRootRecord(existing, incoming) {
  const existingPluginIdentities = unique([
    ...(existing.pluginIdentities ?? []),
    existing.pluginIdentity,
  ].filter(Boolean));
  const incomingPluginIdentities = unique([
    ...(incoming.pluginIdentities ?? []),
    incoming.pluginIdentity,
  ].filter(Boolean));
  const samePluginIdentity = existingPluginIdentities.length <= 1
    && incomingPluginIdentities.length <= 1
    && (existingPluginIdentities[0] ?? undefined)
      === (incomingPluginIdentities[0] ?? undefined);
  const samePluginObservation = existing.origin === "plugin"
    && incoming.origin === "plugin"
    && existing.path === incoming.path
    && samePluginIdentity;
  existing.aliases = unique([
    ...(existing.aliases ?? [existing.path]),
    ...(incoming.aliases ?? [incoming.path]),
  ]);
  existing.owners = unique([
    ...(existing.owners ?? [existing.owner]),
    ...(incoming.owners ?? [incoming.owner]),
  ]);
  const registries = unique([
    ...(existing.registries ?? [existing.registry].filter(Boolean)),
    ...(incoming.registries ?? [incoming.registry].filter(Boolean)),
  ]);
  if (registries.length > 0) existing.registries = registries;
  if (existing.scope !== incoming.scope) {
    existing.scopes = unique([
      ...(existing.scopes ?? [existing.scope]),
      ...(incoming.scopes ?? [incoming.scope]),
    ]);
  }
  if (samePluginObservation && incoming.active !== false) {
    const auditOnly = existing.active === false;
    if (auditOnly || incoming.scope === "global") existing.scope = incoming.scope;
  }
  // A plugin observation promotes the physical source to plugin scan policy,
  // even when a standard root was the first observation for the same copy.
  if (incoming.origin === "plugin") existing.origin = "plugin";
  mergePluginMetadata(existing, incoming);
  // Plugin adapters omit active for installed copies. Preserve that default
  // when an installed observation supersedes an audit-only cache observation.
  if (samePluginObservation && incoming.active !== false) {
    delete existing.active;
  } else if (incoming.active === true) {
    existing.active = true;
  } else if (existing.active === false && incoming.active !== false) {
    delete existing.active;
  }
  mergeBooleanPolicy(existing, incoming, "singleSkill", true);
  mergeBooleanPolicy(existing, incoming, "includeRootSkill", false);
}

/**
 * Normalize all skill-root observations into scan records.
 * Canonical identity and all root-level aggregation happen here so host
 * adapters and Discovery do not reconstruct aliases, owners, plugin metadata,
 * or scan policy for individual root sources.
 *
 * @param {readonly SkillRootObservation[]} observations
 * @returns {{readonly roots: readonly SkillRootScanRecord[], readonly diagnostics: readonly SkillRootDiagnostic[]}}
 */
export function normalizeSkillRootObservations(observations = []) {
  const diagnostics = [];
  if (!Array.isArray(observations)) {
    diagnostics.push(rootDiagnostic(
      "MALFORMED_ROOT_OBSERVATIONS",
      "skill root observations must be an array",
      -1,
    ));
    return freezeDeep({ roots: [], diagnostics });
  }
  const byPhysicalPath = new Map();
  for (const [observationIndex, observation] of observations.entries()) {
    const normalized = normalizeRootObservation(
      observation,
      diagnostics,
      observationIndex,
    );
    if (!normalized) continue;
    const existing = byPhysicalPath.get(normalized.physicalPath);
    if (!existing) {
      byPhysicalPath.set(normalized.physicalPath, normalized);
      continue;
    }
    mergeRootRecord(existing, normalized);
  }
  return freezeDeep({
    roots: [...byPhysicalPath.values()],
    diagnostics,
  });
}

function openClawHome(home, pathExists) {
  for (const directory of [".openclaw", ".clawdbot", ".moltbot"]) {
    if (pathExists(path.join(home, directory))) return path.join(home, directory);
  }
  return path.join(home, ".openclaw");
}

function resolveBase(base, { home, env, pathExists }) {
  if (base === "home") return home;
  if (base === "xdg-config") {
    return env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  }
  if (base === "codex-home") {
    return env.CODEX_HOME?.trim() || path.join(home, ".codex");
  }
  if (base === "claude-home") {
    return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  }
  if (base === "openclaw-home") return openClawHome(home, pathExists);
  throw new TypeError(`unsupported skill-root base ${base}`);
}

/**
 * Expand the checkpointed standard-root declarations into typed observations.
 *
 * @returns {StandardSkillRootObservation[]}
 */
export function registrySkillRoots({
  home = os.homedir(),
  workspaceDirectories = [process.cwd()],
  env = process.env,
  pathExists = existsSync,
} = {}) {
  const roots = [];
  const resolvedHome = path.resolve(home);
  for (const entry of SKILL_ROOT_REGISTRY) {
    for (const workspace of workspaceDirectories) {
      const directory = typeof workspace === "string" ? workspace : workspace.path;
      roots.push({
        kind: "standard",
        path: path.resolve(directory, entry.project),
        owner: entry.owner,
        scope: "workspace",
        origin: typeof workspace === "string"
          ? "project"
          : workspace.origin ?? "project",
        registry: entry.legacy ? "legacy" : "vercel-skills",
      });
    }
    if (entry.global) {
      const [base, relative] = entry.global;
      roots.push({
        kind: "standard",
        path: path.resolve(
          resolveBase(base, { home: resolvedHome, env, pathExists }),
          relative,
        ),
        owner: entry.owner,
        scope: "global",
        origin: "personal",
        registry: entry.legacy ? "legacy" : "vercel-skills",
      });
    }
  }
  return roots;
}
