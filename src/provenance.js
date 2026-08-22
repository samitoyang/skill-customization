import {
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";

/**
 * @typedef {object} ExplicitProvenanceObservation
 * @property {"explicit"} kind
 * @property {string} path
 */

/**
 * @typedef {object} GitProvenanceObservation
 * @property {"git"} kind
 * @property {string} repository
 * @property {string} [upstream_path]
 * @property {string} [upstreamPath]
 */

/**
 * @typedef {object} PluginProvenanceObservation
 * @property {"plugin"} kind
 * @property {string} host
 * @property {string} plugin
 * @property {string} marketplace
 * @property {string} [version]
 * @property {string} [identity]
 * @property {string} [repository]
 * @property {string} [upstream_path]
 * @property {string} [upstreamPath]
 * @property {PluginCacheObservation} [cache]
 * @property {Record<string, unknown>} [installation]
 * @property {Record<string, unknown>} [provenance]
 */

/**
 * @typedef {object} ManagerProvenanceObservation
 * @property {"manager"} kind
 * @property {string} manager
 * @property {string} [identity]
 * @property {string} [repository]
 * @property {string} [upstream_path]
 * @property {string} [upstreamPath]
 * @property {Record<string, unknown>} [provenance]
 */

/**
 * @typedef {object} EmbeddedProvenanceObservation
 * @property {"embedded"} kind
 * @property {string} [identity]
 * @property {string} [repository]
 * @property {string} [upstream_path]
 * @property {string} [upstreamPath]
 */

/**
 * @typedef {object} ConfirmationProvenanceObservation
 * @property {"confirmation"} kind
 * @property {string} [path]
 * @property {string} [provenance]
 * @property {Record<string, unknown>} [confirmationEvidence]
 */

/**
 * @typedef {ExplicitProvenanceObservation | GitProvenanceObservation | PluginProvenanceObservation | ManagerProvenanceObservation | EmbeddedProvenanceObservation | ConfirmationProvenanceObservation} ProvenanceObservation
 */

/**
 * @typedef {object} ProvenanceConfirmation
 * @property {string} [path]
 * @property {string} [provenance]
 * @property {Record<string, unknown>} [evidence]
 */

/**
 * @typedef {object} ProvenanceDiagnostic
 * @property {string} code
 * @property {string} message
 * @property {number} [observationIndex]
 */

/**
 * @typedef {object} ProvenanceConflict
 * @property {"repository" | "repository-path" | "local-identity" | "repository-local"} kind
 * @property {string[]} identities
 * @property {string} [repository]
 * @property {string[]} [paths]
 */

/**
 * @typedef {object} ProvenanceDecision
 * @property {readonly ProvenanceObservation[]} evidence
 * @property {readonly string[]} provenance
 * @property {string} [repository]
 * @property {readonly ProvenanceConflict[]} conflicts
 * @property {boolean} conflict
 * @property {boolean} valid
 * @property {boolean} selectionEligible
 * @property {string} [selectedProvenance]
 * @property {readonly ProvenanceDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} ProvenanceSource
 * @property {"repository" | "local" | "customization"} kind
 * @property {string} [repository]
 * @property {string} [upstream_path]
 * @property {string} [upstreamPath]
 * @property {string} [identity]
 */

/**
 * @typedef {object} PluginCacheObservation
 * @property {"versioned"} kind
 * @property {"global" | "workspace"} scope
 */

/**
 * @typedef {object} ProvenanceCacheSelection
 * @property {string} pluginIdentity
 * @property {PluginCacheObservation} [pluginCache]
 * @property {"global" | "workspace"} [sourceScope]
 */

/**
 * @typedef {object} ProvenanceCacheDecision
 * @property {ProvenanceDecision} decision
 * @property {readonly PluginProvenanceObservation[]} compatibleEvidence
 * @property {readonly PluginCacheObservation[]} compatibleCaches
 * @property {boolean} valid
 * @property {boolean} cacheEligible
 * @property {readonly ProvenanceDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} ProvenanceSelectionDecision
 * @property {ProvenanceDecision} decision
 * @property {readonly string[]} compatibleProvenance
 * @property {boolean} valid
 * @property {boolean} selectionEligible
 * @property {string} [selectedProvenance]
 * @property {readonly ProvenanceDiagnostic[]} diagnostics
 */

const EVIDENCE_ORDER = new Map([
  ["explicit", 0],
  ["git", 1],
  ["plugin", 2],
  ["manager", 3],
  ["embedded", 4],
  ["confirmation", 5],
]);

const OBSERVATION_KINDS = new Set(EVIDENCE_ORDER.keys());

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Return a deterministic key for values carried by checked provenance.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableProvenanceKey(value) {
  const seen = new Set();
  const serialize = (current) => {
    if (Array.isArray(current)) return `[${current.map(serialize).join(",")}]`;
    if (isRecord(current)) {
      if (seen.has(current)) return '"[Circular]"';
      seen.add(current);
      const result = `{${Object.keys(current)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`)
        .join(",")}}`;
      seen.delete(current);
      return result;
    }
    return JSON.stringify(current);
  };
  return serialize(value);
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function diagnostic(code, message, observationIndex) {
  return {
    code,
    message,
    ...(observationIndex === undefined ? {} : { observationIndex }),
  };
}

function addDiagnostic(diagnostics, code, message, observationIndex) {
  diagnostics.push(diagnostic(code, message, observationIndex));
}

function normalizeUpstreamValue(value, diagnostics, observationIndex) {
  if (typeof value !== "string" || !value.trim()) {
    addDiagnostic(
      diagnostics,
      "INVALID_UPSTREAM_EVIDENCE",
      "upstream provenance must be a non-empty path",
      observationIndex,
    );
    return undefined;
  }
  const upstreamPath = normalizeUpstreamEntrypoint(value);
  if (!upstreamPath) {
    addDiagnostic(
      diagnostics,
      "INVALID_UPSTREAM_EVIDENCE",
      "upstream provenance must identify an entrypoint",
      observationIndex,
    );
    return undefined;
  }
  return upstreamPath;
}

function normalizeUpstream(observation, normalized, diagnostics, observationIndex) {
  const snake = observation.upstream_path;
  const camel = observation.upstreamPath;
  if (snake === undefined && camel === undefined) return true;
  const snakePath = snake === undefined
    ? undefined
    : normalizeUpstreamValue(snake, diagnostics, observationIndex);
  const camelPath = camel === undefined
    ? undefined
    : normalizeUpstreamValue(camel, diagnostics, observationIndex);
  if (snakePath && camelPath && snakePath !== camelPath) {
    addDiagnostic(
      diagnostics,
      "CONTRADICTORY_UPSTREAM_EVIDENCE",
      "upstream provenance aliases identify different entrypoints",
      observationIndex,
    );
    return false;
  }
  const upstreamPath = snakePath ?? camelPath;
  if (!upstreamPath) return false;
  normalized.upstream_path = upstreamPath;
  normalized.upstreamPath = upstreamPath;
  return true;
}

function normalizeNestedSource(observation, normalized, diagnostics, observationIndex) {
  if (!isRecord(observation.provenance)) return true;
  const nested = observation.provenance;
  if (nested.repository !== undefined) {
    if (typeof nested.repository !== "string" || !nested.repository.trim()) {
      addDiagnostic(
        diagnostics,
        "INVALID_NESTED_REPOSITORY_EVIDENCE",
        "nested provenance repository must be a non-empty locator",
        observationIndex,
      );
      return false;
    }
    let nestedRepository;
    try {
      nestedRepository = normalizeRepositoryUrl(nested.repository);
    } catch {
      addDiagnostic(
        diagnostics,
        "INVALID_NESTED_REPOSITORY_EVIDENCE",
        `invalid nested repository provenance: ${nested.repository}`,
        observationIndex,
      );
      return false;
    }
    if (normalized.repository && normalized.repository !== nestedRepository) {
      addDiagnostic(
        diagnostics,
        "CONTRADICTORY_PROVENANCE_EVIDENCE",
        "top-level and nested provenance identify different repositories",
        observationIndex,
      );
      return false;
    }
  }
  const nestedObservation = {
    upstream_path: nested.upstream_path,
    upstreamPath: nested.upstreamPath,
  };
  const nestedDiagnostics = [];
  const nestedNormalized = {};
  if (!normalizeUpstream(nestedObservation, nestedNormalized, nestedDiagnostics, observationIndex)) {
    diagnostics.push(...nestedDiagnostics);
    return false;
  }
  if (
    nestedNormalized.upstream_path
    && normalized.upstream_path
    && nestedNormalized.upstream_path !== normalized.upstream_path
  ) {
    addDiagnostic(
      diagnostics,
      "CONTRADICTORY_PROVENANCE_EVIDENCE",
      "top-level and nested provenance identify different entrypoints",
      observationIndex,
    );
    return false;
  }
  return true;
}

function normalizeRepository(observation, normalized, diagnostics, observationIndex, required = false) {
  if (observation.repository === undefined) {
    if (required) {
      addDiagnostic(
        diagnostics,
        "MISSING_REPOSITORY_EVIDENCE",
        `${observation.kind} provenance requires a repository locator`,
        observationIndex,
      );
      return false;
    }
    return true;
  }
  if (typeof observation.repository !== "string" || !observation.repository.trim()) {
    addDiagnostic(
      diagnostics,
      "INVALID_REPOSITORY_EVIDENCE",
      "repository provenance must be a non-empty locator",
      observationIndex,
    );
    return false;
  }
  try {
    normalized.repository = normalizeRepositoryUrl(observation.repository);
  } catch {
    addDiagnostic(
      diagnostics,
      "INVALID_REPOSITORY_EVIDENCE",
      `invalid repository provenance: ${observation.repository}`,
      observationIndex,
    );
    return false;
  }
  return true;
}

function normalizeIdentity(observation, normalized, diagnostics, observationIndex) {
  if (observation.identity === undefined) return true;
  if (typeof observation.identity !== "string" || !observation.identity.trim()) {
    addDiagnostic(
      diagnostics,
      "INVALID_LOCAL_IDENTITY",
      "local provenance identity must be a non-empty string",
      observationIndex,
    );
    return false;
  }
  normalized.identity = observation.identity.trim();
  return true;
}

function normalizeOptionalSource(observation, normalized, diagnostics, observationIndex) {
  if (!normalizeRepository(observation, normalized, diagnostics, observationIndex)) {
    delete normalized.repository;
  }
  if (!normalizeIdentity(observation, normalized, diagnostics, observationIndex)) {
    delete normalized.identity;
  }
}

function normalizePluginCache(observation, normalized, diagnostics, observationIndex) {
  if (observation.cache === undefined) return true;
  if (!isRecord(observation.cache) || observation.cache.kind !== "versioned") {
    addDiagnostic(
      diagnostics,
      "INVALID_PLUGIN_CACHE_EVIDENCE",
      "plugin cache provenance must identify a versioned cache",
      observationIndex,
    );
    return false;
  }
  if (!["global", "workspace"].includes(observation.cache.scope)) {
    addDiagnostic(
      diagnostics,
      "INVALID_PLUGIN_CACHE_SCOPE",
      "versioned plugin cache provenance must use global or workspace scope",
      observationIndex,
    );
    return false;
  }
  normalized.cache = {
    ...observation.cache,
    kind: "versioned",
    scope: observation.cache.scope,
  };
  return true;
}

function normalizeConfirmationObservation(observation, diagnostics, observationIndex) {
  let normalized;
  try {
    normalized = clone(observation);
  } catch {
    addDiagnostic(
      diagnostics,
      "MALFORMED_CONFIRMATION",
      "provenance confirmation must contain cloneable record values",
      observationIndex,
    );
    return undefined;
  }
  if (observation.path !== undefined && (
    typeof observation.path !== "string" || !observation.path.trim()
  )) {
    addDiagnostic(
      diagnostics,
      "INVALID_CONFIRMATION_PATH",
      "confirmation path must be a non-empty string",
      observationIndex,
    );
    return undefined;
  }
  if (observation.provenance !== undefined && (
    typeof observation.provenance !== "string" || !observation.provenance.trim()
  )) {
    addDiagnostic(
      diagnostics,
      "INVALID_CONFIRMATION_PROVENANCE",
      "confirmed provenance must be a non-empty string",
      observationIndex,
    );
    return undefined;
  }
  if (observation.confirmationEvidence !== undefined && (
    !isRecord(observation.confirmationEvidence)
    || Object.keys(observation.confirmationEvidence).length === 0
  )) {
    addDiagnostic(
      diagnostics,
      "INVALID_CONFIRMATION_EVIDENCE",
      "confirmation evidence must be a non-empty object",
      observationIndex,
    );
    return undefined;
  }
  return normalized;
}

function normalizeObservation(observation, diagnostics, observationIndex) {
  if (!isRecord(observation)) {
    addDiagnostic(
      diagnostics,
      "MALFORMED_PROVENANCE_OBSERVATION",
      "provenance observation must be an object",
      observationIndex,
    );
    return undefined;
  }
  if (!OBSERVATION_KINDS.has(observation.kind)) {
    addDiagnostic(
      diagnostics,
      "UNKNOWN_PROVENANCE_KIND",
      `unsupported provenance observation kind: ${String(observation.kind)}`,
      observationIndex,
    );
    return undefined;
  }
  let normalized;
  try {
    normalized = clone(observation);
  } catch {
    addDiagnostic(
      diagnostics,
      "MALFORMED_PROVENANCE_OBSERVATION",
      "provenance observation must contain cloneable record values",
      observationIndex,
    );
    return undefined;
  }
  if (observation.kind === "confirmation") {
    return normalizeConfirmationObservation(normalized, diagnostics, observationIndex);
  }
  if (observation.kind === "explicit") {
    if (typeof observation.path !== "string" || !observation.path.trim()) {
      addDiagnostic(
        diagnostics,
        "INVALID_EXPLICIT_EVIDENCE",
        "explicit provenance requires a non-empty path",
        observationIndex,
      );
      return undefined;
    }
    normalized.path = observation.path;
    return normalized;
  }
  if (observation.kind === "git") {
    if (!normalizeRepository(observation, normalized, diagnostics, observationIndex, true)) {
      return undefined;
    }
  } else if (observation.kind === "plugin") {
    for (const field of ["host", "marketplace"]) {
      if (typeof observation[field] !== "string" || !observation[field].trim()) {
        addDiagnostic(
          diagnostics,
          "MALFORMED_PLUGIN_EVIDENCE",
          `plugin provenance requires a non-empty ${field}`,
          observationIndex,
        );
        return undefined;
      }
    }
    const pluginName = observation.plugin ?? observation.name;
    if (typeof pluginName !== "string" || !pluginName.trim()) {
      addDiagnostic(
        diagnostics,
        "MALFORMED_PLUGIN_EVIDENCE",
        "plugin provenance requires a non-empty plugin name",
        observationIndex,
      );
      return undefined;
    }
    normalizeOptionalSource(observation, normalized, diagnostics, observationIndex);
    if (!normalizePluginCache(observation, normalized, diagnostics, observationIndex)) {
      return undefined;
    }
  } else if (observation.kind === "manager") {
    if (typeof observation.manager !== "string" || !observation.manager.trim()) {
      addDiagnostic(
        diagnostics,
        "MALFORMED_MANAGER_EVIDENCE",
        "manager provenance requires a non-empty manager",
        observationIndex,
      );
      return undefined;
    }
    normalizeOptionalSource(observation, normalized, diagnostics, observationIndex);
  } else if (observation.kind === "embedded") {
    const hasRepository = normalizeRepository(
      observation,
      normalized,
      diagnostics,
      observationIndex,
    );
    const hasIdentity = normalizeIdentity(observation, normalized, diagnostics, observationIndex);
    if (!hasRepository) delete normalized.repository;
    if (!hasIdentity) delete normalized.identity;
    if (!normalized.repository && !normalized.identity) {
      addDiagnostic(
        diagnostics,
        "EMPTY_EMBEDDED_EVIDENCE",
        "embedded provenance requires a repository or local identity",
        observationIndex,
      );
      return undefined;
    }
  }
  if (!normalizeUpstream(observation, normalized, diagnostics, observationIndex)) {
    return undefined;
  }
  if (!normalizeNestedSource(observation, normalized, diagnostics, observationIndex)) {
    return undefined;
  }
  return normalized;
}

function uniqueOrderedEvidence(evidence) {
  const unique = new Map();
  for (const item of evidence) unique.set(stableProvenanceKey(item), item);
  return [...unique.values()].sort(
    (left, right) => EVIDENCE_ORDER.get(left.kind) - EVIDENCE_ORDER.get(right.kind),
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
  if (evidence.provenance) return `manager-source:${stableProvenanceKey(evidence.provenance)}`;
  return undefined;
}

function summarizeProvenance(evidence) {
  const repositories = new Map();
  const local = new Set();
  for (const item of evidence) {
    if (item.kind === "confirmation") continue;
    if (item.repository) {
      const summary = repositories.get(item.repository) ?? {
        repositoryOnly: false,
        paths: new Set(),
      };
      const upstreamPath = normalizeUpstreamEntrypoint(
        item.upstream_path ?? item.upstreamPath,
      );
      if (upstreamPath) summary.paths.add(upstreamPath);
      else summary.repositoryOnly = true;
      repositories.set(item.repository, summary);
      continue;
    }
    const identity = evidenceIdentity(item);
    if (identity) local.add(identity);
  }
  const identities = [];
  for (const [repository, summary] of repositories) {
    if (summary.repositoryOnly) identities.push(`repository:${repository}`);
    for (const upstreamPath of summary.paths) {
      identities.push(`repository:${repository}#${upstreamPath}`);
    }
  }
  identities.push(...local);
  const conflicts = [];
  if (repositories.size > 1) {
    conflicts.push({
      kind: "repository",
      identities: [...repositories.keys()].map((repository) => `repository:${repository}`).sort(),
    });
  }
  for (const [repository, summary] of repositories) {
    if (summary.paths.size > 1) {
      conflicts.push({
        kind: "repository-path",
        repository,
        paths: [...summary.paths].sort(),
        identities: [...summary.paths]
          .map((upstreamPath) => `repository:${repository}#${upstreamPath}`)
          .sort(),
      });
    }
  }
  if (local.size > 1) {
    conflicts.push({
      kind: "local-identity",
      identities: [...local].sort(),
    });
  }
  if (repositories.size > 0 && local.size > 0) {
    conflicts.push({
      kind: "repository-local",
      identities: [
        ...[...repositories.keys()].map((repository) => `repository:${repository}`),
        ...local,
      ].sort(),
    });
  }
  return {
    identities: identities.sort(),
    repository: repositories.size === 1 ? [...repositories.keys()][0] : undefined,
    conflicts,
  };
}

function normalizeConfirmation(confirmation, diagnostics) {
  if (confirmation === undefined) return undefined;
  if (!isRecord(confirmation)) {
    addDiagnostic(
      diagnostics,
      "MALFORMED_CONFIRMATION",
      "provenance confirmation must be an object",
    );
    return undefined;
  }
  if (confirmation.kind !== undefined && confirmation.kind !== "confirmation") {
    addDiagnostic(
      diagnostics,
      "INVALID_CONFIRMATION_KIND",
      "provenance confirmation must use the confirmation kind",
    );
    return undefined;
  }
  const confirmationEvidence = confirmation.evidence ?? confirmation.confirmationEvidence;
  const observation = normalizeConfirmationObservation(
    {
      ...confirmation,
      kind: "confirmation",
      ...(confirmationEvidence === undefined
        ? {}
        : { confirmationEvidence }),
    },
    diagnostics,
  );
  if (!observation) return undefined;
  delete observation.evidence;
  return observation;
}

/**
 * Check provenance observations through the single Provenance evidence seam.
 * The returned records are detached from the caller and deeply immutable.
 *
 * @param {{observations?: readonly ProvenanceObservation[], confirmation?: ProvenanceConfirmation}} [input]
 * @returns {ProvenanceDecision}
 */
export function checkProvenance({ observations, confirmation } = {}) {
  const diagnostics = [];
  const source = observations ?? [];
  if (!Array.isArray(source)) {
    addDiagnostic(
      diagnostics,
      "INVALID_PROVENANCE_OBSERVATIONS",
      "provenance observations must be an array",
    );
  }
  const normalized = Array.isArray(source)
    ? source.flatMap((observation, index) => {
      const value = normalizeObservation(observation, diagnostics, index);
      return value ? [value] : [];
    })
    : [];
  const normalizedConfirmation = normalizeConfirmation(confirmation, diagnostics);
  if (normalizedConfirmation) normalized.push(normalizedConfirmation);
  const orderedEvidence = uniqueOrderedEvidence(normalized);
  const summary = summarizeProvenance(orderedEvidence);
  const confirmedProvenance = normalizedConfirmation?.provenance;
  let selectedProvenance = confirmedProvenance
    ?? (summary.conflicts.length === 0 ? summary.identities[0] : undefined);
  if (confirmedProvenance && !summary.identities.includes(confirmedProvenance)) {
    addDiagnostic(
      diagnostics,
      "PROVENANCE_CONFIRMATION_MISMATCH",
      "confirmed provenance does not belong to the observed provenance",
    );
    selectedProvenance = undefined;
  }
  if (summary.conflicts.length > 0 && !confirmedProvenance) {
    addDiagnostic(
      diagnostics,
      "PROVENANCE_CONFIRMATION_REQUIRED",
      "conflicting provenance requires an explicit confirmation",
    );
  }
  const valid = diagnostics.length === 0;
  const selectionEligible = valid
    && (summary.conflicts.length === 0 || selectedProvenance !== undefined);
  const decision = {
    evidence: orderedEvidence,
    provenance: summary.identities,
    ...(summary.repository ? { repository: summary.repository } : {}),
    conflicts: summary.conflicts,
    conflict: summary.conflicts.length > 0,
    valid,
    selectionEligible,
    ...(selectedProvenance ? { selectedProvenance } : {}),
    diagnostics,
  };
  return /** @type {ProvenanceDecision} */ (freezeDeep(decision));
}

/**
 * Apply a new confirmation to an already checked decision.
 *
 * @param {ProvenanceDecision} decision
 * @param {ProvenanceConfirmation} confirmation
 * @returns {ProvenanceDecision}
 */
export function confirmProvenanceDecision(decision, confirmation) {
  if (!decision || !Array.isArray(decision.evidence)) {
    return checkProvenance({ observations: [], confirmation });
  }
  return checkProvenance({ observations: decision.evidence, confirmation });
}

function checkedProvenanceDecision(decision) {
  return decision
    && Array.isArray(decision.evidence)
    && Array.isArray(decision.provenance)
    ? decision
    : checkProvenance();
}

function checkedProvenanceContext(decision) {
  const checked = checkedProvenanceDecision(decision);
  return {
    checked,
    diagnostics: [
      ...(Array.isArray(checked.diagnostics) ? checked.diagnostics : []),
    ],
  };
}

/**
 * Check whether a checked Provenance decision contains compatible versioned
 * plugin-cache evidence. Every matching plugin observation remains visible in
 * `compatibleEvidence`; `compatibleCaches` collapses only identical cache
 * scopes for Binding state.
 *
 * @param {ProvenanceDecision} decision
 * @param {ProvenanceCacheSelection} selection
 * @returns {ProvenanceCacheDecision}
 */
export function checkProvenanceCache(decision, selection = {}) {
  const { checked, diagnostics } = checkedProvenanceContext(decision);
  const pluginIdentity = typeof selection?.pluginIdentity === "string"
    ? selection.pluginIdentity.trim()
    : selection?.pluginIdentity;
  const requestedCache = selection?.pluginCache;
  const sourceScope = selection?.sourceScope;
  let requestValid = true;
  if (typeof pluginIdentity !== "string" || !pluginIdentity.trim()) {
    diagnostics.push(diagnostic(
      "INVALID_PROVENANCE_CACHE_SELECTION",
      "plugin cache eligibility requires a non-empty plugin identity",
    ));
    requestValid = false;
  }
  if (requestedCache !== undefined) {
    if (!isRecord(requestedCache) || requestedCache.kind !== "versioned") {
      diagnostics.push(diagnostic(
        "INVALID_PROVENANCE_CACHE_SELECTION",
        "plugin cache eligibility requires a versioned cache",
      ));
      requestValid = false;
    } else if (!["global", "workspace"].includes(requestedCache.scope)) {
      diagnostics.push(diagnostic(
        "INVALID_PROVENANCE_CACHE_SELECTION",
        "plugin cache eligibility requires global or workspace scope",
      ));
      requestValid = false;
    }
  }
  if (sourceScope !== undefined && !["global", "workspace"].includes(sourceScope)) {
    diagnostics.push(diagnostic(
      "INVALID_PROVENANCE_CACHE_SELECTION",
      "plugin cache eligibility requires global or workspace source scope",
    ));
    requestValid = false;
  }

  const identityMatches = checked.evidence.filter(
    (evidence) => evidence.kind === "plugin" && evidence.identity === pluginIdentity,
  );
  const compatibleEvidence = requestValid
    ? identityMatches.filter((evidence) =>
      evidence.cache?.kind === "versioned"
      && (
        requestedCache === undefined
        || evidence.cache.scope === requestedCache.scope
      )
      && (
        sourceScope === undefined
        || evidence.cache.scope === sourceScope
      )
    )
    : [];
  const compatibleCaches = [
    ...new Map(
      compatibleEvidence.map((evidence) => [stableProvenanceKey(evidence.cache), evidence.cache]),
    ).values(),
  ];

  if (requestValid && compatibleEvidence.length === 0) {
    if (identityMatches.length === 0) {
      diagnostics.push(diagnostic(
        "PROVENANCE_CACHE_PLUGIN_IDENTITY_MISMATCH",
        "checked provenance does not contain the requested plugin identity",
      ));
    } else if (identityMatches.every(({ cache }) => cache === undefined)) {
      diagnostics.push(diagnostic(
        "PROVENANCE_CACHE_MISSING",
        "checked plugin provenance does not identify a versioned cache",
      ));
    } else if (identityMatches.every(({ cache }) => cache?.kind !== "versioned")) {
      diagnostics.push(diagnostic(
        "PROVENANCE_CACHE_KIND_MISMATCH",
        "checked plugin provenance does not identify a versioned cache",
      ));
    } else {
      diagnostics.push(diagnostic(
        "PROVENANCE_CACHE_SCOPE_MISMATCH",
        "checked plugin provenance does not contain the requested cache scope",
      ));
    }
  }

  const valid = diagnostics.length === 0;
  const cacheEligible = valid
    && checked.selectionEligible
    && compatibleEvidence.length > 0;
  const result = {
    decision: checked,
    compatibleEvidence,
    compatibleCaches,
    valid,
    cacheEligible,
    diagnostics,
  };
  return /** @type {ProvenanceCacheDecision} */ (freezeDeep(result));
}

function checkRepositorySelection({ checked, source, diagnostics }) {
  let repository;
  let upstreamPath;
  try {
    repository = normalizeRepositoryUrl(source.repository);
    upstreamPath = normalizeUpstreamEntrypoint(
      source.upstream_path ?? source.upstreamPath,
    );
  } catch {
    diagnostics.push(diagnostic(
      "INVALID_SOURCE_PROVENANCE",
      "repository source provenance is not a valid repository locator or entrypoint",
    ));
  }
  if (!repository || !upstreamPath) {
    diagnostics.push(diagnostic(
      "INVALID_SOURCE_PROVENANCE",
      "repository source provenance requires a repository locator and entrypoint",
    ));
  }

  let compatibleProvenance = [...checked.provenance];
  if (repository && upstreamPath && checked.provenance.length > 0) {
    const repositoryPrefix = `repository:${repository}`;
    const expected = `${repositoryPrefix}#${upstreamPath}`;
    const observedPaths = new Set(
      checked.evidence
        .filter((item) => item.repository === repository)
        .map((item) => normalizeUpstreamEntrypoint(
          item.upstream_path ?? item.upstreamPath,
        ))
        .filter(Boolean),
    );
    const hasConfirmation = checked.evidence.some(
      (item) => item.kind === "confirmation",
    );
    compatibleProvenance = checked.provenance.filter((identity) =>
      identity === repositoryPrefix || identity === expected,
    );
    if (compatibleProvenance.length === 0) {
      const repositoryIdentities = checked.provenance.filter((identity) =>
        identity === repositoryPrefix || identity.startsWith(`${repositoryPrefix}#`),
      );
      diagnostics.push(diagnostic(
        repositoryIdentities.length > 0
          ? "PROVENANCE_SOURCE_UPSTREAM_PATH_MISMATCH"
          : "PROVENANCE_SOURCE_REPOSITORY_MISMATCH",
        repositoryIdentities.length > 0
          ? "checked provenance does not contain the descriptor upstream entrypoint"
          : "checked provenance does not contain the descriptor repository",
      ));
    }
    if (
      [...observedPaths].some((value) => value !== upstreamPath)
      && !(hasConfirmation && checked.selectedProvenance === expected)
      && !diagnostics.some(({ code }) => code === "PROVENANCE_SOURCE_UPSTREAM_PATH_MISMATCH")
    ) {
      diagnostics.push(diagnostic(
        "PROVENANCE_SOURCE_UPSTREAM_PATH_MISMATCH",
        "checked repository evidence contains an incompatible upstream entrypoint",
      ));
    }
    if (
      checked.selectedProvenance
      && compatibleProvenance.length > 0
      && !compatibleProvenance.includes(checked.selectedProvenance)
    ) {
      diagnostics.push(diagnostic(
        "PROVENANCE_SOURCE_SELECTION_MISMATCH",
        "checked provenance confirmation does not match the descriptor source",
      ));
    }
  }
  return { compatibleProvenance, requiresProvenanceMatch: true };
}

function checkLocalSelection({ checked, source, diagnostics }) {
  if (typeof source.identity === "string") {
    const expectedIdentity = source.identity.startsWith("local:")
      ? source.identity
      : `local:${source.identity}`;
    const observedLocalIdentities = checked.provenance.filter(
      (identity) => identity.startsWith("local:")
        && !identity.startsWith("local:plugin:"),
    );
    const selectedLocalIdentity = checked.selectedProvenance?.startsWith("local:")
      && !checked.selectedProvenance.startsWith("local:plugin:")
      ? checked.selectedProvenance
      : undefined;
    if (
      observedLocalIdentities.length > 0
      && (
        !observedLocalIdentities.includes(expectedIdentity)
        || (
          selectedLocalIdentity !== undefined
          && selectedLocalIdentity !== expectedIdentity
        )
      )
    ) {
      diagnostics.push(diagnostic(
        "PROVENANCE_SOURCE_LOCAL_IDENTITY_MISMATCH",
        "checked local provenance does not match the descriptor identity",
      ));
    }
  }
  return {
    compatibleProvenance: [...checked.provenance],
    requiresProvenanceMatch: false,
  };
}

const PROVENANCE_SOURCE_SELECTION_HANDLERS = Object.freeze({
  repository: checkRepositorySelection,
  local: checkLocalSelection,
  customization: ({ checked }) => ({
    compatibleProvenance: [...checked.provenance],
    requiresProvenanceMatch: false,
  }),
});

/**
 * Check whether a descriptor source can use an already checked evidence decision.
 * Repository identity and upstream compatibility live here so every caller uses
 * the same selection, conflict, and confirmation semantics.
 *
 * @param {ProvenanceDecision} decision
 * @param {ProvenanceSource} source
 * @param {{provenance?: string, path?: string}} [selection]
 * @returns {ProvenanceSelectionDecision}
 */
export function checkProvenanceSelection(decision, source, selection = {}) {
  const { checked, diagnostics } = checkedProvenanceContext(decision);
  let compatibleProvenance = [...checked.provenance];
  const requestedProvenance = selection?.provenance;
  const confirmations = checked.evidence.filter(
    (item) => item.kind === "confirmation",
  );
  const confirmation = confirmations.at(-1);
  if (requestedProvenance !== undefined) {
    if (!confirmation) {
      diagnostics.push(diagnostic(
        "PROVENANCE_CONFIRMATION_REQUIRED",
        "a selected provenance identity requires confirmation evidence",
      ));
    } else {
      if (
        (
          confirmation.provenance !== undefined
          && confirmation.provenance !== requestedProvenance
        )
        || checked.selectedProvenance !== requestedProvenance
      ) {
        diagnostics.push(diagnostic(
          "PROVENANCE_CONFIRMATION_MISMATCH",
          "confirmation evidence does not match the requested provenance identity",
        ));
      }
      if (
        selection.path !== undefined
        && confirmation.path !== selection.path
      ) {
        diagnostics.push(diagnostic(
          "PROVENANCE_CONFIRMATION_PATH_MISMATCH",
          "confirmation evidence does not identify the selected source copy",
        ));
      }
    }
  }

  const sourceHandler = PROVENANCE_SOURCE_SELECTION_HANDLERS[source?.kind];
  if (!sourceHandler) {
    diagnostics.push(diagnostic(
      "INVALID_SOURCE_PROVENANCE",
      "provenance selection requires a repository, local, or customization source",
    ));
  }
  const sourceSelection = sourceHandler
    ? sourceHandler({ checked, source, diagnostics })
    : {
        compatibleProvenance: [...checked.provenance],
        requiresProvenanceMatch: false,
      };
  compatibleProvenance = sourceSelection.compatibleProvenance;

  const valid = diagnostics.length === 0;
  const hasProvenance = checked.provenance.length > 0;
  const selectionEligible = valid
    && checked.selectionEligible
    && (
      !sourceSelection.requiresProvenanceMatch
      || !hasProvenance
      || compatibleProvenance.length > 0
    );
  const selectedProvenance = checked.selectedProvenance
    ?? (selectionEligible && sourceSelection.requiresProvenanceMatch
      ? compatibleProvenance[0]
      : undefined);
  const result = {
    decision: checked,
    compatibleProvenance,
    valid,
    selectionEligible,
    ...(selectedProvenance ? { selectedProvenance } : {}),
    diagnostics,
  };
  return /** @type {ProvenanceSelectionDecision} */ (freezeDeep(result));
}
