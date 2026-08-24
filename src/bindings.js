import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertValidDescriptor,
  matchesCustomizationSource,
  readCheckedDescriptor,
} from "./descriptor.js";
import {
  createDiscoverySnapshot,
  discoverSkills,
} from "./discovery.js";
import { BindingError } from "./errors.js";
import {
  fingerprintFile,
  fingerprintPath,
  payloadFingerprint,
} from "./fingerprint.js";
import { createCustomizationRecoveryAdapter } from "./internal/customization-recovery-adapter.js";
import {
  generateLocalIdentity,
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";
import { isPathContained } from "./paths.js";
import {
  checkProvenance,
  checkProvenanceCache,
  checkProvenanceSelection,
  confirmProvenanceDecision,
  stableProvenanceKey,
} from "./provenance.js";
import { readSkillName } from "./skill-metadata.js";
import { readJsonState, updateJsonAtomic } from "./state.js";

const EMPTY_STORE = { version: 1, bindings: {} };
const MAX_RECOVERY_RETRIES = 1;

const EXPECTED_RECOVERY_MISMATCH_CODES = new Set([
  "BINDING_CUSTOMIZATION_SOURCE_MISMATCH",
  "BINDING_CUSTOMIZATION_METADATA_INVALID",
  "BINDING_DESCRIPTOR_ACTIVATION_MISMATCH",
  "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
  "BINDING_SOURCE_FINGERPRINT_MISMATCH",
  "BINDING_LOCAL_IDENTITY_MISMATCH",
  "BINDING_RETARGETED",
  "BINDING_SOURCE_INVALID",
  "BINDING_SOURCE_KIND_MISMATCH",
  "BINDING_SOURCE_NAME_MISMATCH",
  "BINDING_SOURCE_PROVENANCE_CONFLICT",
  "BINDING_SOURCE_PROVENANCE_MISMATCH",
  "BINDING_SOURCE_SELECTION_INVALID",
  "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
  "BINDING_TARGET_MISSING",
  "INVALID_DESCRIPTOR",
  "MALFORMED_CUSTOMIZATION_METADATA",
  "NO_LOCAL_COPY",
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "FINGERPRINT_SYMLINK",
  "FINGERPRINT_UNSUPPORTED_NODE",
]);

function isExpectedRecoveryMismatch(error) {
  const code = error?.causeCode ?? error?.code;
  return Boolean(code && EXPECTED_RECOVERY_MISMATCH_CODES.has(code));
}

async function existingCanonicalPath(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) return undefined;
  try {
    return path.resolve(await realpath(candidatePath));
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
}

function bindingRecordRevision(binding) {
  return stableProvenanceKey(binding ?? null);
}

function bindingErrorWithCause(message, options, cause) {
  const wrapped = new BindingError(message, options);
  if (cause?.code) wrapped.causeCode = cause.code;
  return wrapped;
}

const SELECTION_DISCOVERY_FINGERPRINT = Symbol("selectionDiscoveryFingerprint");

function cloneRevisionValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function discoveryCopyRevision(group, copy) {
  return {
    name: group.name,
    fingerprint: group.fingerprint,
    conflict: Boolean(group.conflict),
    provenance: cloneRevisionValue(group.provenance ?? []),
    evidence: cloneRevisionValue(group.evidence ?? []),
    copies: cloneRevisionValue(group.copies ?? []),
    selectedCopy: cloneRevisionValue(copy),
  };
}

function bindingInspectionRevision({
  group,
  copy,
  sourceRoot,
  inspection,
}) {
  return {
    canonicalSource: path.resolve(sourceRoot),
    rawSourceFingerprint: inspection.fingerprint,
    entrypointFingerprint: inspection.entrypointFingerprint,
    localIdentity: inspection.localIdentity,
    pluginIdentity: inspection.pluginIdentity,
    pluginCache: cloneRevisionValue(inspection.pluginCache),
    provenance: cloneRevisionValue(inspection.provenance ?? []),
    evidence: cloneRevisionValue(inspection.evidence ?? []),
    selection: cloneRevisionValue(inspection.selection),
    discovery: discoveryCopyRevision(group, copy),
  };
}

function attachBindingInspectionRevision(inspection, revision) {
  Object.defineProperty(inspection, "discoveryRevision", {
    value: revision,
    enumerable: false,
    writable: false,
  });
  return inspection;
}

function bindingLifecycleRevision({ roots, managerRecords, discoveryOptions }) {
  return stableProvenanceKey({
    roots: roots ?? null,
    managerRecords: managerRecords ?? [],
    discoveryOptions: discoveryOptions ?? {},
  });
}

function replacementContextRevision({
  roots,
  managerRecords,
  discoveryOptions,
  discovery,
}) {
  return stableProvenanceKey({
    roots: roots ?? null,
    managerRecords: managerRecords ?? [],
    discoveryOptions: discoveryOptions ?? {},
    discovery: discovery ?? null,
  });
}

function bindingInspectionChanged(previous, current) {
  return !isDeepStrictEqual(
    previous?.discoveryRevision,
    current?.discoveryRevision,
  );
}

function filesystemStatRevision(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

async function filesystemEvidenceRevision({
  sourcePath,
  targetPath,
  entrypoint,
  additionalPaths = [],
  optionalAdditionalPaths = [],
}) {
  const paths = [
    sourcePath,
    targetPath,
    entrypoint,
    ...additionalPaths,
  ]
    .filter((candidate) => typeof candidate === "string" && candidate.trim())
    .map((candidate) => path.resolve(candidate));
  const uniquePaths = [...new Set(paths)].sort();
  try {
    const canonicalTarget = path.resolve(await realpath(targetPath ?? sourcePath));
    const entries = await Promise.all(
      uniquePaths.map(async (candidate) => ({
        path: candidate,
        ...filesystemStatRevision(await lstat(candidate)),
      })),
    );
    const optionalEntries = await Promise.all(
      [...new Set(optionalAdditionalPaths
        .filter((candidate) => typeof candidate === "string" && candidate.trim())
        .map((candidate) => path.resolve(candidate)))]
        .sort()
        .map(async (candidate) => {
          try {
            return { path: candidate, ...filesystemStatRevision(await lstat(candidate)) };
          } catch (error) {
            if (isExpectedRecoveryMismatch(error)) return undefined;
            throw error;
          }
        }),
    );
    return { canonicalTarget, entries: [...entries, ...optionalEntries.filter(Boolean)] };
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
}

function sourceProvenancePaths(sourceRoot) {
  // Git repository identity can change without touching the skill payload.
  // Its config is a lock-safe filesystem token; plugin/manager evidence is
  // additionally refreshed through the targeted pre-publication inspection.
  return [path.join(sourceRoot, ".git", "config")];
}

function stableRevisionValue(value) {
  return stableProvenanceKey(value) ?? "";
}

function sortedRevisionValues(values = []) {
  return values
    .filter((value) => value !== undefined)
    .map((value) => cloneRevisionValue(value))
    .sort((left, right) =>
      stableRevisionValue(left).localeCompare(stableRevisionValue(right), "en"));
}

function normalizedReplacementGroup(group) {
  if (!group) return null;
  return {
    name: group.name,
    fingerprint: group.fingerprint,
    conflict: Boolean(group.conflict),
    nameCollision: Boolean(group.nameCollision),
    provenance: [...(group.provenance ?? [])].sort(),
    evidence: sortedRevisionValues(group.evidence),
  };
}

function normalizedReplacementCopy(copy) {
  if (!copy) return null;
  return {
    path: typeof copy.path === "string" ? path.resolve(copy.path) : copy.path,
    realPath: typeof copy.realPath === "string"
      ? path.resolve(copy.realPath)
      : copy.realPath,
    owner: copy.owner,
    owners: [...(copy.owners ?? [])].sort(),
    scope: copy.scope,
    origin: copy.origin,
    plugin: cloneRevisionValue(copy.plugin),
    pluginMetadata: cloneRevisionValue(copy.pluginMetadata),
    pluginIdentity: copy.pluginIdentity,
    classification: copy.classification,
    active: copy.active,
    conflict: Boolean(copy.conflict),
    customization: cloneRevisionValue(copy.customization),
    provenance: [...(copy.provenance ?? [])].sort(),
    evidence: sortedRevisionValues(copy.evidence),
  };
}

function normalizedReplacementIdentity(candidate) {
  const primaryCopy = candidate.copy ?? candidate.identities?.[0]?.copy;
  const identities = (candidate.identities ?? [])
    .map(({ group, copy }) => ({
      group: normalizedReplacementGroup(group),
      copy: normalizedReplacementCopy(copy),
    }))
    .sort((left, right) =>
      stableRevisionValue(left).localeCompare(stableRevisionValue(right), "en"));
  return {
    name: candidate.name,
    path: path.resolve(candidate.path),
    fingerprint: candidate.fingerprint,
    owner: candidate.owner,
    scope: candidate.scope,
    origin: candidate.origin,
    pluginIdentity: candidate.pluginIdentity,
    pluginCache: cloneRevisionValue(candidate.pluginCache),
    group: normalizedReplacementGroup(candidate.group),
    copy: normalizedReplacementCopy(primaryCopy),
    identities,
    provenance: [...(candidate.provenance ?? [])].sort(),
    evidence: sortedRevisionValues(candidate.evidence),
  };
}

async function replacementCandidateMetadataRevision(candidate) {
  let metadata = null;
  const copy = candidate.copy ?? candidate.identities?.[0]?.copy;
  if (copy?.classification === "customization") {
    try {
      // Keep replacement metadata on the same checked-descriptor ingestion
      // seam as every other customization descriptor.  Raw JSON would accept
      // metadata Discovery and Binding would subsequently reject.
      metadata = (await readCheckedDescriptor(
        path.join(candidate.path, "customization.json"),
      )).descriptor;
    } catch (error) {
      if (isExpectedRecoveryMismatch(error)) return undefined;
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
  return stableProvenanceKey({
    metadata,
    identity: normalizedReplacementIdentity(candidate),
  });
}

function assertBindingRecord(descriptor, binding) {
  assertValidDescriptor(descriptor);
  if (!binding || typeof binding !== "object" || !binding.source) {
    throw new BindingError("binding record is incomplete", {
      code: "INVALID_BINDING_RECORD",
    });
  }
  if (
    binding.customization !== descriptor.id
    || binding.source.skillName !== descriptor.source.skill_name
    || binding.source.kind !== descriptor.source.kind
  ) {
    throw new BindingError("binding source identity no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  }
  if (
    binding.activation?.mode !== descriptor.activation.mode
    || binding.activation?.precedence !== descriptor.activation.precedence
  ) {
    throw new BindingError("binding activation no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_ACTIVATION_MISMATCH",
    });
  }
  bindingSourcePolicyFor(descriptor.source.kind).validateBinding({ descriptor, binding });
}

async function currentBindingTarget(binding) {
  const lookupPath = binding.source.alias ?? binding.source.path;
  let currentTarget;
  try {
    currentTarget = await realpath(lookupPath);
  } catch (error) {
    throw bindingErrorWithCause(
      `binding target is missing: ${lookupPath}`,
      { code: "BINDING_TARGET_MISSING" },
      error,
    );
  }
  if (path.resolve(currentTarget) !== path.resolve(binding.source.target)) {
    throw new BindingError(`binding symlink was retargeted: ${lookupPath}`, {
      code: "BINDING_RETARGETED",
      details: { previous: binding.source.target, current: currentTarget },
    });
  }
  return { lookupPath, currentTarget };
}

async function fullFingerprintRevision({
  descriptor,
  sourceRoot,
  entrypoint,
  expectedEffectiveFingerprint,
  replacementEvidence,
  recoveryContext,
  discoverySnapshot,
  replacementContextRevision: suppliedReplacementContextRevision,
  requireEffectiveMatch = false,
  readOnlyExecution = false,
}) {
  let sourceFingerprint;
  let entrypointFingerprint;
  try {
    [sourceFingerprint, entrypointFingerprint] = await Promise.all([
      fingerprintPath(sourceRoot),
      fingerprintFile(entrypoint),
    ]);
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }

  let effectiveFingerprint = expectedEffectiveFingerprint;
  if (descriptor.source.kind === "customization" && requireEffectiveMatch) {
    if (typeof recoveryContext?.recoverCustomizationExecution !== "function") {
      throw new BindingError(
        "customization source recovery requires the CLI or Preflight runtime",
        {
          code: "BINDING_CUSTOMIZATION_RECOVERY_UNAVAILABLE",
          details: { sourceRoot },
        },
      );
    }
    let execution;
    try {
      execution = await recoveryContext.recoverCustomizationExecution({
        descriptorPath: path.join(sourceRoot, "customization.json"),
        context: recoveryContext.context,
        statePath: recoveryContext.statePath,
        discoverySnapshot:
          recoveryContext.publicationDiscoverySnapshot
          ?? recoveryContext.discoverySnapshot,
        bindings: recoveryContext.bindingOperations,
        readOnly: readOnlyExecution,
      });
    } catch (error) {
      if (isExpectedRecoveryMismatch(error)) return undefined;
      throw error;
    }
    if (
      execution?.status === "maintenance-required"
      || typeof execution?.effectiveFingerprint !== "string"
    ) return undefined;
    effectiveFingerprint = execution.effectiveFingerprint;
  } else if (requireEffectiveMatch) {
    effectiveFingerprint = sourceFingerprint;
  }

  const replacement = [];
  for (const candidate of replacementEvidence?.candidates ?? []) {
    try {
      const copy = candidate.copy ?? candidate.identities?.[0]?.copy;
      const classification = copy?.classification;
      const hasReviewedPayload = typeof copy?.customization
        ?.reviewedPayloadFingerprint === "string";
      const metadataRevision = await replacementCandidateMetadataRevision(candidate);
      if (metadataRevision === undefined) return undefined;
      replacement.push({
        path: path.resolve(candidate.path),
        fingerprint: classification === "customization" && hasReviewedPayload
          ? await payloadFingerprint(candidate.path)
          : await fingerprintPath(candidate.path),
        metadataRevision,
      });
    } catch (error) {
      if (isExpectedRecoveryMismatch(error)) return undefined;
      throw error;
    }
  }
  replacement.sort((left, right) => left.path.localeCompare(right.path, "en"));

  let replacementDiscoveryRevision = replacementEvidence?.discoveryRevision;
  const activeDiscoverySnapshot = discoverySnapshot
    ?? recoveryContext?.publicationDiscoverySnapshot
    ?? recoveryContext?.discoverySnapshot;
  if (
    replacementEvidence?.discoveryRevision !== undefined
    && typeof activeDiscoverySnapshot?.revision === "function"
  ) {
    try {
      replacementDiscoveryRevision = await activeDiscoverySnapshot.revision();
    } catch (error) {
      if (isExpectedRecoveryMismatch(error)) return undefined;
      throw error;
    }
  }
  const currentReplacementContextRevision = suppliedReplacementContextRevision
    ?? (recoveryContext
      ? replacementContextRevision(recoveryContext)
      : replacementEvidence?.contextRevision);

  return {
    sourceFingerprint,
    entrypointFingerprint,
    effectiveFingerprint,
    replacement,
    replacementDiscoveryRevision,
    replacementContextRevision: currentReplacementContextRevision,
  };
}

function fullFingerprintRevisionMatches(
  expected,
  current,
  replacementEvidence,
) {
  if (!current) return false;
  const expectedReplacement = (replacementEvidence?.candidates ?? [])
    .map(({ path: candidatePath, fingerprint, metadataRevision }) => ({
      path: path.resolve(candidatePath),
      fingerprint,
      metadataRevision,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  return (
    current.sourceFingerprint === expected.sourceFingerprint
    && current.entrypointFingerprint === expected.entrypointFingerprint
    && current.effectiveFingerprint === expected.effectiveFingerprint
    && isDeepStrictEqual(current.replacement, expectedReplacement)
    && current.replacementDiscoveryRevision === replacementEvidence?.discoveryRevision
    && current.replacementContextRevision === replacementEvidence?.contextRevision
  );
}

function bindingEvidenceAdditionalPaths(
  descriptor,
  targetPath,
  replacementEvidence,
  statePath,
) {
  const normalizedStatePath = typeof statePath === "string"
    ? path.resolve(statePath)
    : undefined;
  return [
    ...(descriptor.source.kind === "customization"
      ? [path.join(targetPath, "customization.json")]
      : []),
    ...(replacementEvidence?.searchRoots ?? [])
      .filter((rootPath) =>
        !normalizedStatePath || !isPathContained(rootPath, normalizedStatePath)),
    ...(replacementEvidence?.candidates ?? []).map(({ path: candidatePath }) => candidatePath),
    ...(replacementEvidence?.candidates ?? [])
      .filter(({ copy, identities }) =>
        (copy ?? identities?.[0]?.copy)?.classification === "customization")
      .map(({ path: candidatePath }) => path.join(candidatePath, "customization.json")),
  ].filter((candidatePath) =>
    !normalizedStatePath || path.resolve(candidatePath) !== normalizedStatePath);
}

function bindingEvidenceRevision({
  descriptor,
  inspection,
  currentTarget,
  effectiveFingerprint = descriptor.source.effective_fingerprint,
  replacementEvidence,
  filesystemRevision,
}) {
  return {
    canonicalSource: inspection?.discoveryRevision?.canonicalSource,
    canonicalTarget: path.resolve(currentTarget),
    entrypoint: path.resolve(inspection.entrypoint),
    sourceFingerprint: inspection.fingerprint,
    entrypointFingerprint: inspection.entrypointFingerprint,
    effectiveFingerprint,
    provenance: cloneRevisionValue(inspection.provenance ?? []),
    evidence: cloneRevisionValue(inspection.evidence ?? []),
    discovery: cloneRevisionValue(inspection.discoveryRevision?.discovery),
    ...(inspection.pluginIdentity !== undefined
      ? { pluginIdentity: inspection.pluginIdentity }
      : {}),
    ...(inspection.pluginCache !== undefined
      ? { pluginCache: cloneRevisionValue(inspection.pluginCache) }
      : {}),
    ...(inspection.selection !== undefined
      ? { selection: cloneRevisionValue(inspection.selection) }
      : {}),
    ...(replacementEvidence !== undefined
      ? { replacement: cloneRevisionValue(replacementEvidence) }
      : {}),
    ...(filesystemRevision !== undefined
      ? { filesystem: cloneRevisionValue(filesystemRevision) }
      : {}),
  };
}

function bindingEvidenceRevisionFromBinding({ descriptor, binding }) {
  if (binding?.evidenceRevision) return cloneRevisionValue(binding.evidenceRevision);
  return {
    canonicalTarget: binding?.source?.target,
    sourceFingerprint: binding?.source?.fingerprint,
    effectiveFingerprint: descriptor.source.effective_fingerprint,
    provenance: cloneRevisionValue(binding?.source?.provenance ?? []),
    ...(binding?.source?.pluginIdentity !== undefined
      ? { pluginIdentity: binding.source.pluginIdentity }
      : {}),
    ...(binding?.source?.pluginCache !== undefined
      ? { pluginCache: cloneRevisionValue(binding.source.pluginCache) }
      : {}),
    ...(binding?.source?.selection !== undefined
      ? { selection: cloneRevisionValue(binding.source.selection) }
      : {}),
  };
}

function discoveryEvidenceRevision(inspection) {
  const discovery = inspection?.discoveryRevision?.discovery;
  return {
    canonicalSource: inspection?.discoveryRevision?.canonicalSource,
    rawSourceFingerprint: inspection?.discoveryRevision?.rawSourceFingerprint,
    entrypointFingerprint: inspection?.discoveryRevision?.entrypointFingerprint,
    localIdentity: inspection?.discoveryRevision?.localIdentity,
    provenance: cloneRevisionValue(inspection?.provenance ?? []),
    evidence: cloneRevisionValue(inspection?.evidence ?? []),
    selection: cloneRevisionValue(inspection?.selection),
    pluginIdentity: inspection?.pluginIdentity,
    pluginCache: cloneRevisionValue(inspection?.pluginCache),
    discovery: {
      name: discovery?.name,
      fingerprint: discovery?.fingerprint,
      conflict: discovery?.conflict,
      provenance: cloneRevisionValue(discovery?.provenance ?? []),
      evidence: cloneRevisionValue(discovery?.evidence ?? []),
    },
  };
}

function bindingConfirmationEvidenceChanged(previous, current) {
  return !isDeepStrictEqual(
    discoveryEvidenceRevision(previous),
    discoveryEvidenceRevision(current),
  );
}

function publicationProvenanceRevision(inspection) {
  return discoveryEvidenceRevision(inspection);
}

function requiresPublicationProvenanceRefresh(inspection) {
  // An explicit local path has no Discovery-derived provenance to go stale;
  // the filesystem revision is rechecked inside the state CAS instead. Any
  // repository, plugin, manager, or confirmed-selection evidence must be
  // retargeted immediately before publication because it can change without
  // changing the selected skill payload.
  return (
    inspection.selection !== undefined
    || inspection.provenance.length > 0
    || inspection.evidence.some(({ kind }) => kind !== "explicit")
    || inspection.pluginIdentity !== undefined
    || inspection.pluginCache !== undefined
  );
}

function recoveryRevisionFor({
  descriptor,
  inspection,
  currentTarget,
  effectiveFingerprint,
  replacementEvidence,
  filesystemRevision,
}) {
  return bindingEvidenceRevision({
    descriptor,
    inspection,
    currentTarget,
    effectiveFingerprint,
    replacementEvidence,
    filesystemRevision,
  });
}

export function bindingStorePath({ env = process.env, home = os.homedir() } = {}) {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "skill-customization", "bindings.json")
    : path.join(home, ".agents", "skill-customization", "bindings.json");
}

export function bindingKey(customizationId, context) {
  return `${encodeURIComponent(customizationId)}::${encodeURIComponent(context)}`;
}

function assertBindingStore(store, statePath) {
  if (
    store?.version !== 1 ||
    !store.bindings ||
    typeof store.bindings !== "object" ||
    Array.isArray(store.bindings)
  ) {
    throw new BindingError(`invalid binding store ${statePath}`, {
      code: "INVALID_BINDING_STORE",
    });
  }
  return store;
}

export async function readBindingStore(statePath = bindingStorePath()) {
  return assertBindingStore(
    await readJsonState(statePath, EMPTY_STORE),
    statePath,
  );
}

function sanitizeBindingIntentOptions(options = {}) {
  const {
    discovery: _discovery,
    discoverySnapshot: _discoverySnapshot,
    roots: _roots,
    managerRecords: _managerRecords,
    discoveryOptions: _discoveryOptions,
    discover: _discover,
    runtime: _runtime,
    enforceReviewedFingerprint: _enforceReviewedFingerprint,
    refreshDiscovery: _refreshDiscovery,
    refreshFinalDiscovery: _refreshFinalDiscovery,
    revalidateSeededDiscovery: _revalidateSeededDiscovery,
    recoverCustomizationExecution: _recoverCustomizationExecution,
    inspectExecution: _inspectExecution,
    ...intent
  } = options;
  return intent;
}

function bindingDiscoverySnapshot({
  discovery,
  discoverySnapshot,
  roots,
  managerRecords,
}) {
  return discoverySnapshot ?? createDiscoverySnapshot({
    discovery,
    roots,
    managerRecords,
  });
}

function selectBindingSource(
  discovery,
  { sourceRoot, explicitInput } = {},
) {
  if (
    !discovery
    || !Array.isArray(discovery.groups)
    || typeof sourceRoot !== "string"
  ) return undefined;
  const canonicalSource = path.resolve(sourceRoot);
  const explicitPath = path.resolve(explicitInput ?? sourceRoot);
  const groups = discovery.groups.flatMap((group) => {
    const sourceCopies = (group.copies ?? []).filter((copy) => {
      const candidatePath = copy.realPath ?? copy.path;
      return typeof candidatePath === "string"
        && path.resolve(candidatePath) === canonicalSource;
    });
    if (sourceCopies.length === 0) return [];
    const copies = sourceCopies.map((copy) => {
      const decision = checkProvenance({
        observations: [
          ...(copy.evidence ?? []),
          { kind: "explicit", path: explicitPath },
        ],
      });
      const selected = {
        ...copy,
        evidence: [...decision.evidence],
        provenance: [...decision.provenance],
        conflict: decision.conflict,
      };
      Object.defineProperty(selected, "provenanceDecision", {
        value: decision,
        enumerable: false,
        writable: false,
      });
      return selected;
    });
    const decision = checkProvenance({
      observations: copies.flatMap((copy) => copy.evidence),
    });
    const selected = {
      ...group,
      copies,
      evidence: [...decision.evidence],
      provenance: [...decision.provenance],
      conflict: decision.conflict,
    };
    Object.defineProperty(selected, "provenanceDecision", {
      value: decision,
      enumerable: false,
      writable: false,
    });
    return [selected];
  });
  return groups[0];
}

/**
 * Internal operation seam. Lifecycle configuration arrives through the
 * private runtime composition root; returned methods accept only caller
 * intent and interaction policy.
 */
export function createBindingOperation({
  runtime,
  selectSource,
} = {}) {
  if (!runtime || typeof runtime !== "object") {
    throw new TypeError("Binding runtime is required");
  }
  const {
    discovery,
    discoverySnapshot,
    roots,
    managerRecords = [],
    discoveryOptions: operationDiscoveryOptions = {},
    discover,
    recoverCustomizationExecution,
    refreshDiscovery: suppliedRefreshDiscovery,
    revalidateSeededDiscovery: suppliedRevalidateSeededDiscovery,
  } = runtime;
  const revalidateSeededDiscovery = Boolean(
    suppliedRevalidateSeededDiscovery
    || discovery !== undefined
    || discoverySnapshot !== undefined,
  );
  const operationDiscovery = discoverySnapshot ?? createDiscoverySnapshot({
    discovery,
    roots,
    managerRecords,
    options: operationDiscoveryOptions,
    ...(discover ? { discover } : {}),
  });
  const operationRefreshDiscovery = typeof suppliedRefreshDiscovery === "function"
    ? suppliedRefreshDiscovery
    : () => createDiscoverySnapshot({
        roots: roots ?? discovery?.searchedRoots,
        managerRecords,
        options: operationDiscoveryOptions,
        ...(discover ? { discover } : {}),
      });
  const hasSuppliedRefreshDiscovery = typeof suppliedRefreshDiscovery === "function";
  const withOperationContext = (options = {}) => {
    const intent = sanitizeBindingIntentOptions(options);
    return {
      ...intent,
      roots,
      managerRecords,
      discoveryOptions: operationDiscoveryOptions,
      ...(options.selectSource === undefined && selectSource
        ? { selectSource }
        : {}),
      discoverySnapshot: operationDiscovery,
      refreshDiscovery: operationRefreshDiscovery,
      refreshFinalDiscovery: hasSuppliedRefreshDiscovery,
      revalidateSeededDiscovery,
      ...(recoverCustomizationExecution
        ? { recoverCustomizationExecution }
        : {}),
    };
  };
  const operation = {
    bindingKey,
    readBindingStore,
    bindCustomization: (options) =>
      bindCustomizationInternal(withOperationContext(options)),
    resolveBinding: (options) =>
      resolveBindingInternal(withOperationContext(options)),
    validateBinding: (options) =>
      validateBindingInternal(withOperationContext(options)),
    validateBindingReadOnly: (options) =>
      validateBindingReadOnlyInternal(withOperationContext(options)),
  };
  return Object.freeze(operation);
}

function matchingRoot(targetPath, roots) {
  return roots
    .filter((candidate) => candidate.path && isPathContained(candidate.path, targetPath))
    .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0];
}

export async function classifyBindingScope({
  sourcePath,
  roots = [],
  requestedScope,
}) {
  if (requestedScope && !["global", "workspace"].includes(requestedScope)) {
    throw new BindingError("binding scope must be global or workspace", {
      code: "INVALID_BINDING_SCOPE",
    });
  }
  const aliasPath = path.resolve(sourcePath);
  let info;
  let targetPath;
  try {
    info = await lstat(aliasPath);
    targetPath = await realpath(aliasPath);
  } catch (error) {
    throw new BindingError(`binding source is unavailable: ${aliasPath}`, {
      code: "BINDING_TARGET_MISSING",
      details: error.message,
    });
  }
  const canonicalRoots = await Promise.all(
    roots.map(async (candidate) => ({
      ...candidate,
      path: await realpath(candidate.path).catch(() => path.resolve(candidate.path)),
    })),
  );
  const targetRoot = matchingRoot(targetPath, canonicalRoots);
  const sourceRoot = matchingRoot(
    await realpath(path.dirname(aliasPath)).catch(() => path.dirname(aliasPath)),
    canonicalRoots,
  );
  const inferred = targetRoot?.scope ?? (!info.isSymbolicLink() ? sourceRoot?.scope : undefined);
  const scope = inferred === "custom" || !inferred ? requestedScope : inferred;
  if (!scope) {
    throw new BindingError(
      `binding scope is required for custom target ${targetPath}`,
      { code: "BINDING_SCOPE_REQUIRED", details: { aliasPath, targetPath } },
    );
  }
  if (requestedScope && inferred && inferred !== "custom" && requestedScope !== inferred) {
    throw new BindingError(
      `requested ${requestedScope} scope conflicts with ${inferred} target origin`,
      { code: "BINDING_SCOPE_CONFLICT" },
    );
  }
  return {
    scope,
    origin: targetRoot?.origin ?? sourceRoot?.origin ?? "custom-path",
    aliasPath: info.isSymbolicLink() ? aliasPath : undefined,
    targetPath,
  };
}

async function confirmOrFail(callback, payload, code, message) {
  if (typeof callback !== "function" || !(await callback(payload))) {
    throw new BindingError(message, { code });
  }
}

function checkedProvenanceFor(candidate) {
  return candidate.provenanceDecision
    ?? checkProvenance({ observations: candidate.evidence ?? [] });
}

function throwProvenanceSelectionError(
  selectionDecision,
  details,
  { selectionProvided = false } = {},
) {
  const codes = new Set(selectionDecision.diagnostics.map(({ code }) => code));
  if (codes.has("PROVENANCE_CONFIRMATION_REQUIRED")) {
    if (selectionProvided) {
      throw new BindingError(
        "confirmed source selection does not match current discovery evidence",
        {
          code: "BINDING_SOURCE_SELECTION_INVALID",
          details,
        },
      );
    }
    throw new BindingError("binding source provenance is ambiguous", {
      code: "BINDING_SOURCE_PROVENANCE_CONFLICT",
      details,
    });
  }
  if (codes.has("PROVENANCE_SOURCE_UPSTREAM_PATH_MISMATCH")) {
    throw new BindingError(
      "binding source upstream entrypoint does not match the descriptor",
      {
        code: "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
        details,
      },
    );
  }
  if (
    codes.has("PROVENANCE_SOURCE_REPOSITORY_MISMATCH")
    || codes.has("PROVENANCE_SOURCE_SELECTION_MISMATCH")
  ) {
    throw new BindingError("confirmed source provenance does not match the descriptor", {
      code: "BINDING_SOURCE_PROVENANCE_MISMATCH",
      details,
    });
  }
  if (codes.has("PROVENANCE_SOURCE_LOCAL_IDENTITY_MISMATCH")) {
    throw new BindingError("binding source does not match the descriptor local identity", {
      code: "BINDING_LOCAL_IDENTITY_MISMATCH",
      details,
    });
  }
  if (
    codes.has("PROVENANCE_CONFIRMATION_MISMATCH")
    || codes.has("PROVENANCE_CONFIRMATION_PATH_MISMATCH")
    || codes.has("INVALID_CONFIRMATION_KIND")
    || codes.has("INVALID_CONFIRMATION_PATH")
    || codes.has("INVALID_CONFIRMATION_PROVENANCE")
    || codes.has("INVALID_CONFIRMATION_EVIDENCE")
  ) {
    throw new BindingError(
      "confirmed source selection does not match current discovery evidence",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details,
      },
    );
  }
  throw new BindingError("invalid provenance evidence", {
    code: "BINDING_SOURCE_INVALID",
    details: selectionDecision.diagnostics,
  });
}

async function confirmedSelectionFor({
  descriptor,
  group,
  confirmedSelection,
  sourceDirectory,
}) {
  const groupDecision = checkedProvenanceFor(group);
  if (!confirmedSelection) {
    const selectionDecision = checkProvenanceSelection(groupDecision, descriptor.source);
    if (!selectionDecision.selectionEligible) {
      throwProvenanceSelectionError(selectionDecision, groupDecision.provenance);
    }
    return { decision: selectionDecision };
  }
  const [confirmedTarget, sourceTarget] = await Promise.all([
    existingCanonicalPath(confirmedSelection.copy?.path),
    existingCanonicalPath(sourceDirectory),
  ]);
  const copy = group.copies.find(
    (candidate) =>
      path.resolve(candidate.realPath ?? candidate.path) === confirmedTarget
      && confirmedTarget === sourceTarget,
  );
  const requestedFingerprint = confirmedSelection[SELECTION_DISCOVERY_FINGERPRINT]
    ?? confirmedSelection.fingerprint;
  const confirmation = confirmedSelection.confirmation
    ?? [...(confirmedSelection.evidence ?? [])]
      .reverse()
      .find((item) => item.kind === "confirmation");
  if (!(
    confirmedSelection.name === group.name
    && copy
    && typeof confirmedSelection.provenance === "string"
    && (
      requestedFingerprint === undefined
      || requestedFingerprint === group.fingerprint
    )
  )) {
    throw new BindingError(
      "confirmed source selection does not match current discovery evidence",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: { confirmedSelection, currentProvenance: group.provenance },
      },
    );
  }

  const confirmedDecision = confirmProvenanceDecision(
    checkedProvenanceFor(copy),
    confirmation
      ? {
          ...confirmation,
          ...(confirmation.confirmationEvidence
            ? { evidence: confirmation.confirmationEvidence }
            : {}),
        }
      : undefined,
  );
  const selectionDecision = checkProvenanceSelection(
    confirmedDecision,
    descriptor.source,
    {
      provenance: confirmedSelection.provenance,
      path: confirmedSelection.copy?.path,
    },
  );
  if (!selectionDecision.selectionEligible) {
    throwProvenanceSelectionError(selectionDecision, {
      confirmedSelection,
      currentProvenance: group.provenance,
    }, { selectionProvided: true });
  }
  const selection = {
    name: group.name,
    // Persist the copy from the current checked discovery result. The
    // caller's selection is only the confirmation request; its copied
    // evidence may already be stale by the time this inspection completes.
    // Preserve a confirmed alias as the user-facing selection path while
    // taking all metadata and evidence from the current copy.
    copy: {
      ...structuredClone(copy),
      ...(typeof confirmedSelection.copy?.path === "string"
        ? { path: confirmedSelection.copy.path }
        : {}),
    },
    provenance: selectionDecision.selectedProvenance,
    confirmation: structuredClone(confirmation),
  };
  Object.defineProperty(selection, SELECTION_DISCOVERY_FINGERPRINT, {
    value: group.fingerprint,
    enumerable: false,
    writable: false,
  });
  return {
    decision: selectionDecision,
    selection,
  };
}

function rejectCustomizationCandidate(group) {
  if (group.copies.some((copy) => copy.classification === "customization")) {
    throw new BindingError("a customization candidate requires source.kind customization", {
      code: "BINDING_SOURCE_KIND_MISMATCH",
    });
  }
}

function inspectRepositorySource({ descriptor, group }) {
  rejectCustomizationCandidate(group);
  return {
    repository: normalizeRepositoryUrl(descriptor.source.repository),
    upstreamPath: normalizeUpstreamEntrypoint(descriptor.source.upstream_path),
  };
}

function inspectLocalSource({ group }) {
  rejectCustomizationCandidate(group);
  return {};
}

async function inspectCustomizationSource({ descriptor, info, sourceRoot }) {
  if (!info.isDirectory()) {
    throw new BindingError("a customization source must be bound by its directory", {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  let checkedCustomization;
  try {
    checkedCustomization = await readCheckedDescriptor(
      path.join(sourceRoot, "customization.json"),
    );
  } catch (error) {
    throw bindingErrorWithCause(
      `bound customization metadata is invalid: ${error.message}`,
      { code: "BINDING_CUSTOMIZATION_METADATA_INVALID" },
      error,
    );
  }
  const customization = checkedCustomization.descriptor;
  if (!matchesCustomizationSource(descriptor.source, customization)) {
    throw new BindingError("bound customization identity does not match the descriptor source", {
      code: "BINDING_CUSTOMIZATION_SOURCE_MISMATCH",
      details: {
        expected: descriptor.source,
        actual: {
          id: customization.id,
          type: customization.type,
          skill_name: customization.name,
          license: customization.license,
        },
      },
    });
  }
  return {
    entrypoint: path.join(
      checkedCustomization.location.canonicalRoot,
      customization.entrypoint,
    ),
    declaredName: customization.name,
    customization: {
      id: customization.id,
      type: customization.type,
      license: customization.license,
    },
  };
}

function localSourceIdentity({ skillName, fingerprint }) {
  return {
    fingerprint,
    identity: generateLocalIdentity({ skillName, fingerprint }),
  };
}

function assertLocalInspection({
  descriptor,
  localIdentity,
  requireLocalIdentityMatch,
}) {
  if (
    requireLocalIdentityMatch
    && localIdentity !== descriptor.source.identity
  ) {
    throw new BindingError("binding source does not match the descriptor local identity", {
      code: "BINDING_LOCAL_IDENTITY_MISMATCH",
      details: { expected: descriptor.source.identity, actual: localIdentity },
    });
  }
}

function assertRepositoryBinding({ descriptor, binding }) {
  const expectedRepository = normalizeRepositoryUrl(descriptor.source.repository);
  const expectedUpstreamPath = normalizeUpstreamEntrypoint(
    descriptor.source.upstream_path,
  );
  if (
    binding.source.repository !== expectedRepository
    || binding.source.upstreamPath !== expectedUpstreamPath
  ) {
    throw new BindingError("binding repository source no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
      details: {
        expected: {
          repository: expectedRepository,
          upstreamPath: expectedUpstreamPath,
        },
        actual: {
          repository: binding.source.repository,
          upstreamPath: binding.source.upstreamPath,
        },
      },
    });
  }
}

function assertRepositoryInspection({ descriptor, binding, inspection }) {
  const persistedFingerprint = binding.source.fingerprint;
  const reviewedFingerprint = descriptor.source.effective_fingerprint;
  // A descriptor whose reviewed checkpoint already differs from the persisted
  // Binding is handled by Preflight/Reconciliation as source drift. Once the
  // two checkpoints agree, a later repository change invalidates this Binding
  // and requires a fresh source confirmation.
  if (
    typeof persistedFingerprint !== "string"
    || persistedFingerprint !== reviewedFingerprint
    || inspection.fingerprint === persistedFingerprint
  ) return;
  throw new BindingError("binding repository source fingerprint changed", {
    code: "BINDING_SOURCE_FINGERPRINT_MISMATCH",
    details: {
      expectedFingerprint: persistedFingerprint,
      reviewedFingerprint,
      actualFingerprint: inspection.fingerprint,
    },
  });
}

function assertLocalBinding({ descriptor, binding }) {
  if (binding.source.localIdentity !== descriptor.source.identity) {
    throw new BindingError("binding local source no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  }
}

function assertCustomizationBinding({ descriptor, binding }) {
  if (
    binding.source.customization?.id !== descriptor.source.id
    || binding.source.customization?.type !== descriptor.source.type
    || binding.source.customization?.license !== descriptor.source.license
  ) {
    throw new BindingError("binding customization source no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  }
}

async function inspectBindingSource({
  descriptor,
  sourcePath,
  roots,
  managerRecords,
  confirmedSelection,
  selectSource,
  discoverySnapshot,
  revalidateSeededDiscovery = false,
  requireLocalIdentityMatch = true,
}) {
  const resolved = path.resolve(sourcePath);
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw bindingErrorWithCause(
      `binding source is unavailable: ${resolved}`,
      { code: "BINDING_SOURCE_INVALID" },
      error,
    );
  }
  if (
    descriptor.source.kind !== "customization"
    && !info.isDirectory()
    && path.basename(resolved) !== "SKILL.md"
  ) {
    throw new BindingError("a file binding source must be named SKILL.md", {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  const sourceRoot = await realpath(
    info.isDirectory() ? resolved : path.dirname(resolved),
  );
  let sourceMetadata;
  const entrypoint = descriptor.source.kind === "customization"
    ? (sourceMetadata = await inspectCustomizationSource({
        descriptor,
        info,
        sourceRoot,
      })).entrypoint
    : (info.isDirectory() ? path.join(resolved, "SKILL.md") : resolved);
  let declaredName = sourceMetadata?.declaredName;
  if (declaredName === undefined) {
    try {
      declaredName = await readSkillName(entrypoint);
    } catch (error) {
      if (!isExpectedRecoveryMismatch(error)) throw error;
    }
  }
  if (declaredName !== descriptor.source.skill_name) {
    throw new BindingError(
      `binding source declares ${declaredName ?? "no name"}; expected ${descriptor.source.skill_name}`,
      { code: "BINDING_SOURCE_NAME_MISMATCH" },
    );
  }
  let discovery;
  try {
    const discoveryInput = sourcePolicy.discoveryInput({ resolved, sourceRoot });
    if (discoverySnapshot && revalidateSeededDiscovery) {
      // A seeded inventory is request-scoped evidence, not a durable source
      // identity. Always target the source path for Binding inspection so a
      // persisted provenance or selection cannot be accepted from stale
      // inventory metadata. The snapshot still memoizes this targeted lookup
      // for the rest of the operation.
      discovery = await discoverySnapshot.discover({ input: discoveryInput });
    } else if (discoverySnapshot) {
      const inventory = await discoverySnapshot.inventory();
      const selected = selectBindingSource(inventory, {
        sourceRoot,
        explicitInput: discoveryInput,
      });
      discovery = selected
        ? { ...inventory, groups: [selected] }
        : await discoverySnapshot.discover({ input: discoveryInput });
    } else {
      discovery = await discoverSkills({
        input: discoveryInput,
        roots,
        managerRecords,
      });
    }
  } catch (error) {
    throw bindingErrorWithCause(
      `binding source is not a discoverable skill: ${error.message}`,
      { code: "BINDING_SOURCE_INVALID", details: error.details },
      error,
    );
  }
  const group = discovery.groups[0];
  if (!group) {
    throw new BindingError("binding source is not present in discovery", {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  const selectedSource = confirmedSelection
    ?? (group.conflict && typeof selectSource === "function"
      ? await selectSource({ discovery, group, sourceRoot, entrypoint })
      : undefined);
  const selectionResult = await confirmedSelectionFor({
    descriptor,
    group,
    confirmedSelection: selectedSource,
    sourceDirectory: sourcePolicy.sourceDirectory({ sourceRoot, entrypoint }),
  });
  const selection = selectionResult.selection;
  const provenanceSelection = selectionResult.decision;
  const sourceCopies = group.copies.filter(
    (copy) => path.resolve(copy.realPath ?? copy.path) === sourceRoot,
  );
  const sourceEvidence = sourceCopies.flatMap((copy) => checkedProvenanceFor(copy).evidence);
  const pluginIdentities = [...new Set([
    ...sourceCopies.map(({ pluginIdentity }) => pluginIdentity),
    ...sourceEvidence
      .filter(({ kind }) => kind === "plugin")
      .filter(({ identity }) => typeof identity === "string")
      .map(({ identity }) => identity),
  ].filter(Boolean))];
  const bindingPluginIdentity = selection
    && pluginIdentities.includes(selection.provenance)
    ? selection.provenance
    : pluginIdentities.length === 1
      ? pluginIdentities[0]
      : undefined;
  const bindingPluginCaches = bindingPluginIdentity
    ? sourceCopies.flatMap((copy) => {
        if (!["global", "workspace"].includes(copy.scope)) return [];
        return checkProvenanceCache(checkedProvenanceFor(copy), {
          pluginIdentity: bindingPluginIdentity,
          pluginCache: { kind: "versioned", scope: copy.scope },
          sourceScope: copy.scope,
        }).compatibleCaches;
      })
    : [];
  const uniqueBindingPluginCaches = [
    ...new Map(bindingPluginCaches.map((cache) => [stableProvenanceKey(cache), cache])).values(),
  ];
  const bindingPluginCache = uniqueBindingPluginCaches.length === 1
    ? uniqueBindingPluginCaches[0]
    : undefined;
  sourceMetadata ??= await sourcePolicy.inspect({
    descriptor,
    group,
    info,
    sourceRoot,
  });
  let fingerprint;
  let entrypointFingerprint;
  try {
    fingerprint = await fingerprintPath(sourceRoot);
    entrypointFingerprint = await fingerprintFile(entrypoint);
  } catch (error) {
    throw bindingErrorWithCause(
      `binding source cannot be fingerprinted: ${error.message}`,
      { code: "BINDING_SOURCE_INVALID" },
      error,
    );
  }
  const localEvidence = localSourceIdentity({
    skillName: descriptor.source.skill_name,
    fingerprint: entrypointFingerprint,
  });
  sourcePolicy.assertInspection?.({
    descriptor,
    localIdentity: localEvidence.identity,
    requireLocalIdentityMatch,
  });
  const inspection = {
    declaredName,
    entrypoint,
    fingerprint,
    entrypointFingerprint,
    localIdentity: localEvidence.identity,
    ...sourceMetadata,
    provenance: selection
      ? [selection.provenance]
      : provenanceSelection.decision.provenance,
    evidence: [...provenanceSelection.decision.evidence],
    searchedRoots: discovery.searchedRoots,
    selection,
    provenanceSelection,
    ...(bindingPluginIdentity
      ? { pluginIdentity: bindingPluginIdentity }
      : {}),
    ...(bindingPluginCache
      ? { pluginCache: structuredClone(bindingPluginCache) }
      : {}),
  };
  return attachBindingInspectionRevision(
    inspection,
    bindingInspectionRevision({
      group,
      copy: sourceCopies[0] ?? group.copies[0],
      sourceRoot,
      inspection,
    }),
  );
}

async function validateBindingReadOnlyInternal({
  descriptor,
  binding,
  requireLocalIdentityMatch = false,
}) {
  assertBindingRecord(descriptor, binding);
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  const { lookupPath, currentTarget } = await currentBindingTarget(binding);
  let info;
  try {
    info = await stat(currentTarget);
  } catch (error) {
    throw bindingErrorWithCause(
      `binding source is unavailable: ${currentTarget}`,
      { code: "BINDING_SOURCE_INVALID" },
      error,
    );
  }
  if (
    descriptor.source.kind !== "customization"
    && !info.isDirectory()
    && path.basename(currentTarget) !== "SKILL.md"
  ) {
    throw new BindingError("a file binding source must be named SKILL.md", {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  const sourceRoot = info.isDirectory() ? currentTarget : path.dirname(currentTarget);
  let sourceMetadata;
  const entrypoint = descriptor.source.kind === "customization"
    ? (sourceMetadata = await inspectCustomizationSource({
        descriptor,
        info,
        sourceRoot,
      })).entrypoint
    : (info.isDirectory() ? path.join(currentTarget, "SKILL.md") : currentTarget);
  let declaredName = sourceMetadata?.declaredName;
  if (declaredName === undefined) {
    try {
      declaredName = await readSkillName(entrypoint);
    } catch (error) {
      throw bindingErrorWithCause(
        `binding source metadata is unavailable: ${entrypoint}`,
        { code: "BINDING_SOURCE_INVALID" },
        error,
      );
    }
  }
  if (declaredName !== descriptor.source.skill_name) {
    throw new BindingError(
      `binding source declares ${declaredName ?? "no name"}; expected ${descriptor.source.skill_name}`,
      { code: "BINDING_SOURCE_NAME_MISMATCH" },
    );
  }
  let fingerprint;
  let entrypointFingerprint;
  try {
    [fingerprint, entrypointFingerprint] = await Promise.all([
      fingerprintPath(sourceRoot),
      fingerprintFile(entrypoint),
    ]);
  } catch (error) {
    throw bindingErrorWithCause(
      `binding source cannot be fingerprinted: ${error.message}`,
      { code: "BINDING_SOURCE_INVALID" },
      error,
    );
  }
  const localEvidence = localSourceIdentity({
    skillName: descriptor.source.skill_name,
    fingerprint: entrypointFingerprint,
  });
  sourcePolicy.assertInspection?.({
    descriptor,
    localIdentity: localEvidence.identity,
    requireLocalIdentityMatch,
  });
  return {
    binding,
    currentTarget,
    inspection: {
      declaredName,
      entrypoint,
      fingerprint,
      entrypointFingerprint,
      localIdentity: localEvidence.identity,
      ...sourceMetadata,
      provenance: cloneRevisionValue(binding.source.provenance ?? []),
      evidence: cloneRevisionValue(binding.evidenceRevision?.evidence ?? []),
      selection: cloneRevisionValue(binding.source.selection),
      ...(binding.source.pluginIdentity
        ? { pluginIdentity: binding.source.pluginIdentity }
        : {}),
      ...(binding.source.pluginCache
        ? { pluginCache: cloneRevisionValue(binding.source.pluginCache) }
        : {}),
    },
  };
}

const BINDING_OPERATIONS = Object.freeze({
  bindingKey,
  readBindingStore,
  resolveBinding: resolveBindingInternal,
  validateBinding: validateBindingInternal,
  validateBindingReadOnly: validateBindingReadOnlyInternal,
});

function matchesCustomizationCopy(source, group, copy) {
  return copy.classification === "customization"
    && group.name === source.skill_name
    && copy.customization?.id === source.id
    && copy.customization?.type === source.type
    && copy.customization?.license === source.license;
}

async function recoverStandardFingerprint({ copy }) {
  try {
    return await fingerprintPath(copy.path);
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
}

async function recoverCustomizationFingerprint({
  recoveryContext,
  group,
  copy,
}) {
  const {
    descriptor,
    context,
    statePath,
    discoverySnapshot,
    bindingOperations = BINDING_OPERATIONS,
    recoverCustomizationExecution,
  } = recoveryContext;
  if (!matchesCustomizationCopy(descriptor.source, group, copy)) return undefined;
  // The graph runner is injected by the Preflight/runtime composition root;
  // Binding only asks for the candidate's checked effective result.
  if (typeof recoverCustomizationExecution !== "function") {
    throw new BindingError(
      "customization source recovery requires the CLI or Preflight runtime",
      {
        code: "BINDING_CUSTOMIZATION_RECOVERY_UNAVAILABLE",
        details: { sourcePath: copy.path, customizationId: descriptor.source.id },
      },
    );
  }
  let execution;
  try {
    execution = await recoverCustomizationExecution({
      descriptorPath: path.join(copy.path, "customization.json"),
      context,
      statePath,
      discoverySnapshot,
      bindings: bindingOperations,
    });
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
  return execution?.status === "maintenance-required"
    ? undefined
    : execution?.effectiveFingerprint;
}

async function matchesLocalRecoveredSource({ descriptor, copy }) {
  try {
    const localEvidence = localSourceIdentity({
      skillName: descriptor.source.skill_name,
      fingerprint: await fingerprintFile(path.join(copy.path, "SKILL.md")),
    });
    return localEvidence.identity === descriptor.source.identity;
  } catch (error) {
    if (!isExpectedRecoveryMismatch(error)) throw error;
    return false;
  }
}

const BINDING_SOURCE_POLICIES = Object.freeze({
  repository: Object.freeze({
    discoveryInput: ({ resolved }) => resolved,
    sourceDirectory: ({ entrypoint }) => path.dirname(entrypoint),
    inspect: inspectRepositorySource,
    bindingFields: ({ inspection }) => ({
      repository: inspection.repository,
      upstreamPath: inspection.upstreamPath,
    }),
    validateBinding: assertRepositoryBinding,
    validateInspection: assertRepositoryInspection,
    recoveryFingerprint: recoverStandardFingerprint,
  }),
  local: Object.freeze({
    discoveryInput: ({ resolved }) => resolved,
    sourceDirectory: ({ entrypoint }) => path.dirname(entrypoint),
    inspect: inspectLocalSource,
    assertInspection: assertLocalInspection,
    bindingFields: ({ inspection }) => ({
      localIdentity: inspection.localIdentity,
    }),
    validateBinding: assertLocalBinding,
    // Local Binding identity is derived from SKILL.md bytes, but a confirmed
    // local Binding remains available across content drift for reconciliation.
    recoveryFingerprint: recoverStandardFingerprint,
    matchesRecoveredCopy: matchesLocalRecoveredSource,
  }),
  customization: Object.freeze({
    discoveryInput: ({ sourceRoot }) => sourceRoot,
    sourceDirectory: ({ sourceRoot }) => sourceRoot,
    inspect: inspectCustomizationSource,
    bindingFields: ({ inspection }) => ({ customization: inspection.customization }),
    validateBinding: assertCustomizationBinding,
    recoveryFingerprint: recoverCustomizationFingerprint,
  }),
});

function bindingSourcePolicyFor(kind) {
  const policy = BINDING_SOURCE_POLICIES[kind];
  if (!policy) {
    throw new BindingError(`unsupported binding source kind ${kind}`, {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  return policy;
}

function bindingSourceFromInspection({
  descriptor,
  sourcePath,
  targetPath,
  scope,
  inspection,
  aliasPath,
  confirmation,
}) {
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  const selection = inspection.selection;
  return {
    path: path.resolve(sourcePath),
    target: path.resolve(targetPath),
    ...(aliasPath ? { alias: aliasPath } : {}),
    skillName: inspection.declaredName,
    kind: descriptor.source.kind,
    ...(sourcePolicy.bindingFields?.({ inspection }) ?? {}),
    fingerprint: inspection.fingerprint,
    provenance: inspection.provenance,
    ...(inspection.pluginIdentity
      ? { pluginIdentity: inspection.pluginIdentity }
      : {}),
    ...(inspection.pluginCache?.scope === scope
      ? { pluginCache: inspection.pluginCache }
      : {}),
    ...(selection ? { selection } : {}),
    confirmation: confirmation ?? (
      selection
        ? "provenance-confirmed"
        : inspection.provenance.length === 0
          ? "user-confirmed"
          : "evidence-confirmed"
    ),
  };
}

async function recoverMissingPluginBinding({
  binding,
  recoveryContext,
}) {
  const {
    descriptor,
    roots,
    managerRecords,
    customizationRoot,
    discoverySnapshot,
  } = recoveryContext;
  const { pluginCache, pluginIdentity } = binding.source;
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  if (
    !pluginIdentity
    || pluginCache?.kind !== "versioned"
    || pluginCache.scope !== binding.scope
  ) return undefined;
  // A cache path is replaceable local state; continuity is safe only for one
  // stable plugin identity and one already reviewed effective fingerprint.
  let inventory;
  try {
    inventory = discoverySnapshot
      ? await discoverySnapshot.inventory()
      : await discoverSkills({
          input: descriptor.source.skill_name,
          roots,
          managerRecords,
        });
  } catch (error) {
    if (error.code === "NO_LOCAL_COPY") return undefined;
    throw error;
  }
  const excludedRoot = descriptor.activation.mode === "replace" && customizationRoot
    ? await existingCanonicalPath(customizationRoot) ?? path.resolve(customizationRoot)
    : undefined;
  const findMatches = async (discovery) => {
    const matches = [];
    for (const group of discovery.groups) {
      if (group.name !== descriptor.source.skill_name) continue;
      for (const copy of group.copies) {
        if (copy.active === false) continue;
        const canonicalPath = await existingCanonicalPath(copy.path);
        if (!canonicalPath) continue;
        if (
          excludedRoot
          && canonicalPath === excludedRoot
        ) continue;
        const cacheDecision = checkProvenanceCache(
          checkedProvenanceFor(copy),
          { pluginIdentity, pluginCache, sourceScope: copy.scope },
        );
        if (!cacheDecision.cacheEligible) continue;
        const effectiveFingerprint = await sourcePolicy.recoveryFingerprint({
          recoveryContext,
          group,
          copy,
        });
        if (effectiveFingerprint !== descriptor.source.effective_fingerprint) continue;
        if (
          sourcePolicy.matchesRecoveredCopy
          && !(await sourcePolicy.matchesRecoveredCopy({ descriptor, copy }))
        ) continue;
        const provenanceDecision = checkProvenanceSelection(
          cacheDecision.decision,
          descriptor.source,
        );
        const provenance = provenanceDecision.selectedProvenance
          ?? provenanceDecision.compatibleProvenance[0];
        if (provenanceDecision.selectionEligible && provenance) {
          matches.push({
            group,
            copy,
            // Recovery has no fresh human confirmation. Preserve the complete
            // checked evidence identity set of this candidate instead of
            // reducing it to the first compatible identity.
            provenance: [...provenanceDecision.decision.provenance],
            selectedProvenance: provenance,
          });
        }
      }
    }
    return matches;
  };
  const mergeMatches = async (seededMatches, targetedMatches) => {
    const merged = new Map();
    for (const candidate of [...seededMatches, ...targetedMatches]) {
      const canonicalPath = await existingCanonicalPath(candidate.copy.path);
      if (!canonicalPath) continue;
      const previous = merged.get(canonicalPath);
      if (!previous) {
        merged.set(canonicalPath, candidate);
        continue;
      }
      const provenanceAgrees = isDeepStrictEqual(
        previous.provenance,
        candidate.provenance,
      );
      merged.set(canonicalPath, {
        group: {
          ...candidate.group,
          conflict: Boolean(
            previous.group.conflict
            || candidate.group.conflict
            || !provenanceAgrees,
          ),
          provenance: [
            ...new Set([
              ...(previous.group.provenance ?? []),
              ...(candidate.group.provenance ?? []),
            ]),
          ],
          evidence: [
            ...new Map(
              [
                ...(previous.group.evidence ?? []),
                ...(candidate.group.evidence ?? []),
              ].map((evidence) => [JSON.stringify(evidence), evidence]),
            ).values(),
          ],
        },
        copy: {
          ...candidate.copy,
          conflict: Boolean(
            previous.copy.conflict
            || candidate.copy.conflict
            || !provenanceAgrees,
          ),
          provenance: [
            ...new Set([
              ...(previous.copy.provenance ?? []),
              ...(candidate.copy.provenance ?? []),
            ]),
          ],
          evidence: [
            ...new Map(
              [
                ...(previous.copy.evidence ?? []),
                ...(candidate.copy.evidence ?? []),
              ].map((evidence) => [JSON.stringify(evidence), evidence]),
            ).values(),
          ],
        },
        provenance: provenanceAgrees ? previous.provenance : undefined,
        selectedProvenance: provenanceAgrees
          ? previous.selectedProvenance
          : undefined,
      });
    }
    return [...merged.values()];
  };
  let matches = await findMatches(inventory);
  if (discoverySnapshot) {
    try {
      const targetedMatches = await findMatches(
        await discoverySnapshot.discover({ input: descriptor.source.skill_name }),
      );
      matches = await mergeMatches(matches, targetedMatches);
    } catch (error) {
      if (error.code === "NO_LOCAL_COPY") return undefined;
      throw error;
    }
  }
  if (matches.length !== 1) return undefined;
  const { group, copy, provenance } = matches[0];
  // A replacement cache copy is not a substitute for human provenance review.
  if (group.conflict || copy.conflict) return undefined;
  const {
    alias: _alias,
    selection: _selection,
    confirmation: _confirmation,
    ...stableSource
  } = binding.source;
  const target = await existingCanonicalPath(copy.path);
  if (!target) return undefined;
  const source = {
    ...stableSource,
    path: path.resolve(copy.path),
    target,
    provenance: [...provenance],
  };
  return {
    binding: { ...binding, source, updatedAt: new Date().toISOString() },
    group,
    copy,
  };
}

async function revalidateRecoveredBinding({
  descriptor,
  recovered,
  group,
  copy,
  recoveryContext,
}) {
  const {
    roots,
    managerRecords,
    customizationRoot,
    discoverySnapshot,
    statePath,
    discoveryOptions,
    discovery,
    revalidateSeededDiscovery,
  } = recoveryContext;
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  let validation;
  let effectiveFingerprint;
  try {
    if (copy.active === false) return undefined;
    if (
      sourcePolicy.matchesRecoveredCopy
      && !(await sourcePolicy.matchesRecoveredCopy({ descriptor, copy }))
    ) return undefined;
    validation = await validateBindingInternal({
      descriptor,
      binding: recovered,
      roots,
      managerRecords,
      discoveryOptions,
      discovery,
      customizationRoot,
      discoverySnapshot,
      revalidateSeededDiscovery,
      requireLocalIdentityMatch: descriptor.source.kind === "local",
      // Resolution keeps source-drift decisions with Preflight/Reconciliation;
      // this check still validates the candidate's current source state.
      enforceReviewedFingerprint: false,
    });
    effectiveFingerprint = await sourcePolicy.recoveryFingerprint({
      recoveryContext,
      group,
      copy,
    });
    if (effectiveFingerprint !== descriptor.source.effective_fingerprint) {
      return undefined;
    }
    const expectedProvenance = recovered.source.provenance;
    const actualProvenance = validation.inspection.provenance;
    if (
      !isDeepStrictEqual(expectedProvenance, actualProvenance)
    ) {
      return undefined;
    }
    if (
      recovered.source.selection !== undefined
      && !isDeepStrictEqual(
        recovered.source.selection,
        validation.inspection.selection,
      )
    ) {
      return undefined;
    }
    if (
      recovered.source.pluginIdentity
      && validation.inspection.pluginIdentity !== recovered.source.pluginIdentity
    ) {
      return undefined;
    }
    if (
      recovered.source.pluginCache
      && !isDeepStrictEqual(
        validation.inspection.pluginCache,
        recovered.source.pluginCache,
      )
    ) {
      return undefined;
    }
    if (
      recovered.source.localIdentity
      && validation.inspection.localIdentity !== recovered.source.localIdentity
    ) {
      return undefined;
    }
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }

  const filesystemRevision = await filesystemEvidenceRevision({
    sourcePath: copy.path,
    targetPath: validation.currentTarget,
    entrypoint: validation.inspection.entrypoint,
    additionalPaths: bindingEvidenceAdditionalPaths(
      descriptor,
      validation.currentTarget,
      validation.replacementEvidence,
      statePath,
    ),
    optionalAdditionalPaths: sourceProvenancePaths(validation.currentTarget),
  });
  if (!filesystemRevision) return undefined;
  const revision = recoveryRevisionFor({
    descriptor,
    inspection: validation.inspection,
    currentTarget: validation.currentTarget,
    effectiveFingerprint,
    replacementEvidence: validation.replacementEvidence,
    filesystemRevision,
  });
  const source = bindingSourceFromInspection({
    descriptor,
    sourcePath: copy.path,
    targetPath: validation.currentTarget,
    scope: recovered.scope,
    inspection: validation.inspection,
  });
  const binding = {
    ...recovered,
    source,
    evidenceRevision: revision,
    updatedAt: new Date().toISOString(),
  };
  return {
    binding,
    revision,
  };
}

function discoverySnapshotLike(value) {
  return value
    && typeof value.inventory === "function"
    && typeof value.discover === "function";
}

async function refreshedDiscoverySnapshot({
  refreshDiscovery,
  roots,
  managerRecords,
}) {
  if (typeof refreshDiscovery !== "function") return undefined;
  try {
    const refreshed = await refreshDiscovery();
    return discoverySnapshotLike(refreshed)
      ? refreshed
      : createDiscoverySnapshot({
          discovery: refreshed,
          roots,
          managerRecords,
        });
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
}

async function locateRecoveryCandidate({
  descriptor,
  sourcePath,
  discoverySnapshot,
  expectedPluginIdentity,
}) {
  const canonicalSource = await existingCanonicalPath(sourcePath);
  if (!canonicalSource) return undefined;
  let discovery;
  try {
    discovery = await discoverySnapshot.discover({ input: sourcePath });
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
  const matches = new Map();
  for (const group of discovery.groups ?? []) {
    if (group.name !== descriptor.source.skill_name) continue;
    for (const copy of group.copies ?? []) {
      if (copy.active === false) continue;
      const canonicalCopy = await existingCanonicalPath(copy.path);
      if (canonicalCopy !== canonicalSource) continue;
      const current = matches.get(canonicalCopy);
      const preferred = expectedPluginIdentity
        && copy.pluginIdentity === expectedPluginIdentity;
      if (!current || preferred) matches.set(canonicalCopy, { group, copy });
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

async function revalidateRecoveryCandidate(candidate, recoveryContext) {
  const snapshot = await refreshedDiscoverySnapshot(recoveryContext);
  if (!snapshot) return undefined;
  recoveryContext.publicationDiscoverySnapshot = snapshot;
  const located = await locateRecoveryCandidate({
    descriptor: recoveryContext.descriptor,
    sourcePath: candidate.binding.source.path,
    discoverySnapshot: snapshot,
    expectedPluginIdentity: candidate.binding.source.pluginIdentity,
  });
  if (!located) return undefined;
  const currentContext = {
    ...recoveryContext,
    discoverySnapshot: snapshot,
    bindingOperations: recoveryContext.createRecoveryBindingOperations
      ? recoveryContext.createRecoveryBindingOperations(snapshot)
      : recoveryContext.bindingOperations,
  };
  recoveryContext.bindingOperations = currentContext.bindingOperations;
  const result = await revalidateRecoveredBinding({
    descriptor: recoveryContext.descriptor,
    recovered: candidate.binding,
    group: located.group,
    copy: located.copy,
    recoveryContext: currentContext,
  });
  return result;
}

async function recoveryCandidateStillCurrent(candidate, recoveryContext) {
  if (!candidate?.binding?.source || !candidate?.revision) return undefined;
  let current;
  try {
    current = await revalidateRecoveryCandidate(candidate, recoveryContext);
  } catch (error) {
    if (isExpectedRecoveryMismatch(error)) return undefined;
    throw error;
  }
  if (!current || !isDeepStrictEqual(candidate.revision, current.revision)) {
    return undefined;
  }
  return current.binding;
}

function replacementGroupIdentity(group) {
  return {
    name: group.name,
    fingerprint: group.fingerprint,
    conflict: Boolean(group.conflict),
    nameCollision: Boolean(group.nameCollision),
    provenance: cloneRevisionValue(group.provenance ?? []),
    evidence: cloneRevisionValue(group.evidence ?? []),
  };
}

function replacementCopyIdentity(copy, canonicalPath) {
  return {
    ...structuredClone(copy),
    path: path.resolve(copy.path),
    realPath: canonicalPath,
  };
}

function mergeReplacementCandidateIdentity(candidate, identity) {
  candidate.identities.push(identity);
  candidate.identities.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  candidate.fingerprints = [
    ...new Set(candidate.identities.map(({ group }) => group.fingerprint)),
  ].sort();
  candidate.provenance = [
    ...new Set(candidate.identities.flatMap(({ group, copy }) => [
      ...(group.provenance ?? []),
      ...(copy.provenance ?? []),
    ])),
  ].sort();
  candidate.evidence = [
    ...new Map(
      candidate.identities
        .flatMap(({ group, copy }) => [
          ...(group.evidence ?? []),
          ...(copy.evidence ?? []),
        ])
        .map((evidence) => [JSON.stringify(evidence), evidence]),
    ).values(),
  ].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  return candidate;
}

async function assertReplacementActivation({
  descriptor,
  customizationRoot,
  discoverySnapshot,
  contextRevision,
}) {
  if (descriptor.activation.mode !== "replace") {
    return {
      mode: "coexist",
      candidates: [],
      ...(contextRevision !== undefined ? { contextRevision } : {}),
    };
  }
  let discovery;
  try {
    // Replacement ambiguity is a current-state decision. A seeded inventory
    // remains useful to source inspection, but cannot keep a renamed,
    // deactivated, or otherwise invalid candidate alive merely because its
    // directory still exists.
    discovery = await discoverySnapshot.discover({ input: descriptor.name });
  } catch (error) {
    if (error.code !== "NO_LOCAL_COPY") throw error;
    discovery = { groups: [] };
  }
  const activeSkillsByPath = new Map();
  for (const group of discovery.groups ?? []) {
    for (const copy of group.copies ?? []) {
      if (copy.active === false) continue;
      const candidatePath = copy.realPath ?? copy.path;
      // Only current canonical paths participate in ambiguity; never fall
      // back to a stale lexical path.
      const canonicalPath = await existingCanonicalPath(candidatePath);
      if (!canonicalPath) continue;
      const key = `${group.name}\0${canonicalPath}`;
      const identity = {
        group: replacementGroupIdentity(group),
        copy: replacementCopyIdentity(copy, canonicalPath),
      };
      const current = activeSkillsByPath.get(key);
      if (!current) {
        activeSkillsByPath.set(key, {
          name: group.name,
          path: canonicalPath,
          fingerprint: group.fingerprint,
          owner: copy.owner,
          scope: copy.scope,
          origin: copy.origin,
          fingerprints: [group.fingerprint],
          provenance: [
            ...new Set([
              ...(group.provenance ?? []),
              ...(copy.provenance ?? []),
            ]),
          ].sort(),
          evidence: [
            ...new Map(
              [
                ...(group.evidence ?? []),
                ...(copy.evidence ?? []),
              ].map((evidence) => [JSON.stringify(evidence), evidence]),
            ).values(),
          ].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right), "en")),
          group: identity.group,
          copy: identity.copy,
          identities: [identity],
        });
      } else {
        mergeReplacementCandidateIdentity(current, identity);
      }
    }
  }
  let activeSkills = [...activeSkillsByPath.values()];
  if (customizationRoot) {
    const excludedRoot = await existingCanonicalPath(customizationRoot)
      ?? path.resolve(customizationRoot);
    activeSkills = activeSkills.filter(
      ({ path: skillPath }) => path.resolve(skillPath) !== excludedRoot,
    );
  }
  const sameName = activeSkills.filter(({ name }) => name === descriptor.name);
  if (sameName.length > 1) {
    throw new BindingError("replacement activation is ambiguous in this host context", {
      code: "AMBIGUOUS_REPLACEMENT",
      details: sameName,
    });
  }
  const candidates = [];
  for (const skill of sameName) {
    const candidate = {
      name: skill.name,
      path: path.resolve(skill.path),
      fingerprint: skill.fingerprint,
      owner: skill.owner,
      scope: skill.scope,
      origin: skill.origin,
      fingerprints: [...skill.fingerprints],
      provenance: cloneRevisionValue(skill.provenance),
      evidence: cloneRevisionValue(skill.evidence),
      group: cloneRevisionValue(skill.group),
      copy: cloneRevisionValue(skill.copy),
      identities: cloneRevisionValue(skill.identities),
      ...(skill.copy?.pluginIdentity !== undefined
        ? { pluginIdentity: skill.copy.pluginIdentity }
        : {}),
      ...(skill.copy?.pluginCache !== undefined
        ? { pluginCache: cloneRevisionValue(skill.copy.pluginCache) }
        : {}),
    };
    const metadataRevision = await replacementCandidateMetadataRevision(candidate);
    if (metadataRevision === undefined) {
      throw new BindingError("replacement customization metadata changed before confirmation", {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: { path: candidate.path },
      });
    }
    candidates.push({ ...candidate, metadataRevision });
  }
  const discoveryRevision = typeof discoverySnapshot.revision === "function"
    ? await discoverySnapshot.revision()
    : undefined;
  return {
    mode: "replace",
    searchRoots: (discovery.searchedRoots ?? [])
      .map(({ path: rootPath }) => rootPath)
      .filter((rootPath) => typeof rootPath === "string")
      .sort(),
    candidates,
    ...(contextRevision !== undefined ? { contextRevision } : {}),
    ...(discoveryRevision !== undefined ? { discoveryRevision } : {}),
  };
}

async function bindCustomizationInternal({
  descriptor,
  sourcePath,
  context,
  statePath = bindingStorePath(),
  roots,
  customizationRoot,
  requestedScope,
  interactive = Boolean(process.stdin.isTTY),
  confirm,
  confirmReplace,
  managerRecords = [],
  discoveryOptions = {},
  confirmedSelection,
  selectSource,
  requestScope,
  refreshDiscovery,
  refreshFinalDiscovery = false,
  discovery,
  discoverySnapshot,
  recoverCustomizationExecution,
  revalidateSeededDiscovery = false,
  now = () => new Date().toISOString(),
}) {
  assertValidDescriptor(descriptor);
  if (typeof context !== "string" || !context.trim()) {
    throw new BindingError("binding context is required", { code: "BINDING_CONTEXT_REQUIRED" });
  }
  const key = bindingKey(descriptor.id, context);
  const operationDiscovery = bindingDiscoverySnapshot({
    discovery,
    discoverySnapshot,
    roots,
    managerRecords,
  });
  const refreshOperationDiscovery = typeof refreshDiscovery === "function"
    ? refreshDiscovery
    : () => operationDiscovery;
  const initialLifecycleRevision = bindingLifecycleRevision({
    roots,
    managerRecords,
    discoveryOptions,
  });
  const store = await readBindingStore(statePath);
  if (store.bindings[key]) {
    return resolveBindingInternal({
      descriptor,
      context,
      statePath,
      roots,
      managerRecords,
      discoveryOptions,
      discovery,
      customizationRoot,
      discoverySnapshot: operationDiscovery,
      refreshDiscovery: refreshOperationDiscovery,
      recoverCustomizationExecution,
      revalidateSeededDiscovery,
    });
  }
  if (!interactive) {
    throw new BindingError("first use requires interactive source confirmation", {
      code: "FIRST_USE_CONFIRMATION_REQUIRED",
    });
  }
  const inspection = await inspectBindingSource({
    descriptor,
    sourcePath,
    roots,
    managerRecords,
    confirmedSelection,
    selectSource,
    discoverySnapshot: operationDiscovery,
    revalidateSeededDiscovery,
  });
  const initialEffectiveFingerprint = descriptor.source.effective_fingerprint;
  const scopeRoots = roots ?? inspection.searchedRoots.filter(
    ({ scope }) => scope === "global" || scope === "workspace",
  );
  let classified;
  try {
    classified = await classifyBindingScope({
      sourcePath,
      roots: scopeRoots,
      requestedScope,
    });
  } catch (error) {
    if (error.code !== "BINDING_SCOPE_REQUIRED" || typeof requestScope !== "function") {
      throw error;
    }
    classified = await classifyBindingScope({
      sourcePath,
      roots: scopeRoots,
      requestedScope: await requestScope({ descriptor, context, sourcePath, inspection }),
    });
  }
  await confirmOrFail(
    confirm,
    { descriptor, context, source: classified, inspection },
    "FIRST_USE_CONFIRMATION_REQUIRED",
    "source binding was not confirmed",
  );
  if (descriptor.activation.mode === "replace") {
    await confirmOrFail(
      confirmReplace,
      {
        descriptor,
        context,
        precedence: descriptor.activation.precedence,
      },
      "REPLACEMENT_CONFIRMATION_REQUIRED",
      "replacement activation requires explicit confirmation",
    );
  }
  const initialReplacementEvidence = await assertReplacementActivation({
    descriptor,
    customizationRoot,
    discoverySnapshot: operationDiscovery,
    contextRevision: replacementContextRevision({
      roots,
      managerRecords,
      discoveryOptions,
      discovery,
    }),
  });
  // Confirmation callbacks may finish a user-approved source update before
  // returning. Establish the publication baseline after that interaction;
  // later changes still have to match this checked evidence.
  const confirmedInspection = await inspectBindingSource({
    descriptor,
    sourcePath,
    roots,
    managerRecords,
    confirmedSelection: inspection.selection ?? confirmedSelection,
    discoverySnapshot: operationDiscovery,
    revalidateSeededDiscovery,
  });

  // Finish the source and replacement decision before acquiring the state
  // lock. The lock is only the persistence seam; Discovery, fingerprinting,
  // scope classification, and replacement validation do not belong inside
  // its critical section.
  const lifecycleChanged = bindingLifecycleRevision({
    roots,
    managerRecords,
    discoveryOptions,
  }) !== initialLifecycleRevision;
  const needsFreshFinalDiscovery = (
    descriptor.activation.mode === "replace"
    || refreshFinalDiscovery
    || lifecycleChanged
    || requiresPublicationProvenanceRefresh(confirmedInspection)
  );
  let finalDiscovery = needsFreshFinalDiscovery
    ? await refreshOperationDiscovery()
    : operationDiscovery;
  let finalInspection = await inspectBindingSource({
    descriptor,
    sourcePath,
    roots,
    managerRecords,
    confirmedSelection: confirmedInspection.selection ?? confirmedSelection,
    discoverySnapshot: finalDiscovery,
    revalidateSeededDiscovery,
  });
  if (
    finalDiscovery === operationDiscovery
    && bindingInspectionChanged(confirmedInspection, finalInspection)
  ) {
    finalDiscovery = await refreshOperationDiscovery();
    finalInspection = await inspectBindingSource({
      descriptor,
      sourcePath,
      roots,
      managerRecords,
      confirmedSelection: confirmedInspection.selection ?? confirmedSelection,
      discoverySnapshot: finalDiscovery,
      revalidateSeededDiscovery,
    });
  }
  if (bindingConfirmationEvidenceChanged(confirmedInspection, finalInspection)) {
    throw new BindingError(
      "binding source evidence changed after first-use confirmation",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: {
          confirmed: discoveryEvidenceRevision(confirmedInspection),
          current: discoveryEvidenceRevision(finalInspection),
        },
      },
    );
  }
  if (descriptor.source.effective_fingerprint !== initialEffectiveFingerprint) {
    throw new BindingError(
      "binding source effective fingerprint changed after first-use confirmation",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: {
          confirmed: initialEffectiveFingerprint,
          current: descriptor.source.effective_fingerprint,
        },
      },
    );
  }
  const finalClassified = await classifyBindingScope({
    sourcePath,
    roots: scopeRoots,
    requestedScope: classified.scope,
  });
  const finalReplacementEvidence = await assertReplacementActivation({
    descriptor,
    customizationRoot,
    discoverySnapshot: finalDiscovery,
    contextRevision: replacementContextRevision({
      roots,
      managerRecords,
      discoveryOptions,
      discovery,
    }),
  });
  if (!isDeepStrictEqual(initialReplacementEvidence, finalReplacementEvidence)) {
    throw new BindingError(
      "replacement activation evidence changed after confirmation",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: {
          confirmed: initialReplacementEvidence,
          current: finalReplacementEvidence,
        },
      },
    );
  }
  const filesystemRevision = await filesystemEvidenceRevision({
    sourcePath,
    targetPath: finalClassified.targetPath,
    entrypoint: finalInspection.entrypoint,
    additionalPaths: bindingEvidenceAdditionalPaths(
      descriptor,
      finalClassified.targetPath,
      finalReplacementEvidence,
      statePath,
    ),
    optionalAdditionalPaths: sourceProvenancePaths(finalClassified.targetPath),
  });
  if (!filesystemRevision) {
    throw new BindingError("binding source changed before publication", {
      code: "BINDING_SOURCE_SELECTION_INVALID",
    });
  }
  const evidenceRevision = bindingEvidenceRevision({
    descriptor,
    inspection: finalInspection,
    currentTarget: finalClassified.targetPath,
    replacementEvidence: finalReplacementEvidence,
    filesystemRevision,
  });
  const timestamp = await now();
  // Discovery is deliberately outside the state lock. Re-target provenance
  // evidence after caller callbacks complete, but do not replay a targeted
  // lookup for a purely explicit local binding: its filesystem token is
  // compared again inside the publication CAS below.
  const publicationInspection = requiresPublicationProvenanceRefresh(finalInspection)
    ? await inspectBindingSource({
        descriptor,
        sourcePath,
        roots,
        managerRecords,
        confirmedSelection: finalInspection.selection ?? confirmedSelection,
        discoverySnapshot: await refreshOperationDiscovery(),
        revalidateSeededDiscovery: true,
      })
    : finalInspection;
  if (!isDeepStrictEqual(
    publicationProvenanceRevision(finalInspection),
    publicationProvenanceRevision(publicationInspection),
  )) {
    throw new BindingError("binding source provenance changed before publication", {
      code: "BINDING_SOURCE_SELECTION_INVALID",
    });
  }
  const candidateBinding = {
    customization: descriptor.id,
    context,
    scope: finalClassified.scope,
    origin: finalClassified.origin,
    activation: descriptor.activation,
    source: bindingSourceFromInspection({
      descriptor,
      sourcePath,
      targetPath: finalClassified.targetPath,
      scope: finalClassified.scope,
      inspection: finalInspection,
      aliasPath: finalClassified.aliasPath,
    }),
    evidenceRevision,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const initialBindingRevision = bindingRecordRevision(store.bindings[key]);
  let persistedBinding;
  let created = false;
  await updateJsonAtomic(statePath, EMPTY_STORE, async (current) => {
    assertBindingStore(current, statePath);
    // This is the complete atomic decision: publish only if the caller's
    // expected key and checked evidence token are unchanged. Discovery and
    // candidate generation stay outside the lock; the selected source,
    // entrypoint, effective, and replacement fingerprints are rechecked
    // inside the cross-process state lock.
    if (
      bindingRecordRevision(current.bindings[key]) !== initialBindingRevision
    ) {
      persistedBinding = current.bindings[key];
      return current;
    }
    const currentFilesystemRevision = await filesystemEvidenceRevision({
      sourcePath,
      targetPath: candidateBinding.source.target,
      entrypoint: evidenceRevision.entrypoint,
      additionalPaths: bindingEvidenceAdditionalPaths(
        descriptor,
        candidateBinding.source.target,
        evidenceRevision.replacement,
        statePath,
      ),
      optionalAdditionalPaths: sourceProvenancePaths(candidateBinding.source.target),
    });
    if (!isDeepStrictEqual(currentFilesystemRevision, evidenceRevision.filesystem)) {
      throw new BindingError("binding source evidence changed before publication", {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: {
          expected: evidenceRevision,
          current: {
            ...evidenceRevision,
            filesystem: currentFilesystemRevision,
          },
        },
      });
    }
    const currentFullFingerprintRevision = await fullFingerprintRevision({
      descriptor,
      sourceRoot: evidenceRevision.canonicalSource ?? path.resolve(sourcePath),
      entrypoint: evidenceRevision.entrypoint,
      expectedEffectiveFingerprint: evidenceRevision.effectiveFingerprint,
      replacementEvidence: evidenceRevision.replacement,
      discoverySnapshot: finalDiscovery,
      replacementContextRevision: replacementContextRevision({
        roots,
        managerRecords,
        discoveryOptions,
        discovery,
      }),
    });
    if (
      !fullFingerprintRevisionMatches(
        evidenceRevision,
        currentFullFingerprintRevision,
        evidenceRevision.replacement,
      )
    ) {
      throw new BindingError("binding source fingerprint changed before publication", {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: {
          expected: evidenceRevision,
          current: {
            ...evidenceRevision,
            ...currentFullFingerprintRevision,
          },
        },
      });
    }
    if (!isDeepStrictEqual(candidateBinding.evidenceRevision, evidenceRevision)) {
      throw new BindingError("binding publication evidence is inconsistent", {
        code: "BINDING_PUBLICATION_CONFLICT",
        details: {
          expected: evidenceRevision,
          current: candidateBinding.evidenceRevision,
        },
      });
    }
    current.bindings[key] = candidateBinding;
    persistedBinding = candidateBinding;
    created = true;
    return current;
  });
  if (created) return persistedBinding;
  if (!persistedBinding) {
    throw new BindingError("binding state changed before publication", {
      code: "BINDING_PUBLICATION_CONFLICT",
    });
  }
  return validateBindingInternal({
    descriptor,
    binding: persistedBinding,
    roots,
    managerRecords,
    discoveryOptions,
    discovery,
    customizationRoot,
    discoverySnapshot: operationDiscovery,
    revalidateSeededDiscovery,
  }).then((result) => result.binding);
}

async function invalidate(statePath, key, expectedBinding) {
  let invalidated = false;
  await updateJsonAtomic(statePath, EMPTY_STORE, async (store) => {
    assertBindingStore(store, statePath);
    if (!isDeepStrictEqual(store.bindings[key], expectedBinding)) return store;
    delete store.bindings[key];
    invalidated = true;
    return store;
  });
  return invalidated;
}

async function validateBindingInternal({
  descriptor,
  binding,
  roots,
  customizationRoot,
  managerRecords = [],
  discoveryOptions = {},
  discovery,
  discoverySnapshot,
  enforceReviewedFingerprint = true,
  requireLocalIdentityMatch = false,
  revalidateSeededDiscovery = false,
}) {
  assertBindingRecord(descriptor, binding);
  const operationDiscovery = bindingDiscoverySnapshot({
    discovery,
    discoverySnapshot,
    roots,
    managerRecords,
  });
  const replacementEvidence = await assertReplacementActivation({
    descriptor,
    customizationRoot,
    discoverySnapshot: operationDiscovery,
    contextRevision: replacementContextRevision({
      roots,
      managerRecords,
      discoveryOptions,
      discovery,
    }),
  });

  const { lookupPath, currentTarget } = await currentBindingTarget(binding);
  const inspection = await inspectBindingSource({
    descriptor,
    sourcePath: lookupPath,
    roots,
    managerRecords,
    confirmedSelection: binding.source.selection,
    discoverySnapshot: operationDiscovery,
    revalidateSeededDiscovery,
    requireLocalIdentityMatch,
  });
  if (enforceReviewedFingerprint) {
    bindingSourcePolicyFor(descriptor.source.kind).validateInspection?.({
      descriptor,
      binding,
      inspection,
    });
  }
  return {
    binding,
    inspection,
    currentTarget,
    replacementEvidence,
  };
}

async function resolveBindingInternal({
  descriptor,
  context,
  statePath = bindingStorePath(),
  roots,
  customizationRoot,
  managerRecords = [],
  discoveryOptions = {},
  discovery,
  discoverySnapshot,
  refreshDiscovery,
  recoverCustomizationExecution,
  revalidateSeededDiscovery = false,
  recoveryAttempts = 0,
}) {
  assertValidDescriptor(descriptor);
  const operationDiscovery = bindingDiscoverySnapshot({
    discovery,
    discoverySnapshot,
    roots,
    managerRecords,
  });
  const refreshOperationDiscovery = typeof refreshDiscovery === "function"
    ? refreshDiscovery
    : () => operationDiscovery;
  const createRecoveryBindingOperations = (snapshot) => createBindingOperation({
    runtime: {
      discoverySnapshot: snapshot,
      roots,
      managerRecords,
      discoveryOptions,
      refreshDiscovery: refreshOperationDiscovery,
      recoverCustomizationExecution,
      revalidateSeededDiscovery,
    },
  });
  const operationBindings = createRecoveryBindingOperations(operationDiscovery);
  const store = await readBindingStore(statePath);
  const initialBindingRevision = bindingRecordRevision(
    store.bindings[bindingKey(descriptor.id, context)],
  );
  const key = bindingKey(descriptor.id, context);
  const binding = store.bindings[key];
  if (!binding) {
    throw new BindingError(`no binding for ${descriptor.id} in ${context}`, {
      code: "BINDING_NOT_FOUND",
    });
  }
  const initialBindingEvidenceRevision = bindingEvidenceRevisionFromBinding({
    descriptor,
    binding,
  });
  try {
    return (
      await validateBindingInternal({
        descriptor,
        binding,
        roots,
        managerRecords,
        discoveryOptions,
        discovery,
        customizationRoot,
        discoverySnapshot: operationDiscovery,
        revalidateSeededDiscovery,
        // Preflight and Reconciliation own full-source drift decisions after
        // they have the resolved path; public Binding validation remains strict.
        enforceReviewedFingerprint: false,
      })
    ).binding;
  } catch (error) {
    if (
      error.code === "BINDING_TARGET_MISSING"
      && recoveryAttempts < MAX_RECOVERY_RETRIES
    ) {
      const recoveryContext = {
        descriptor,
        context,
        statePath,
        roots,
        managerRecords,
        discoveryOptions,
        discovery,
        customizationRoot,
        discoverySnapshot: operationDiscovery,
        refreshDiscovery: refreshOperationDiscovery,
        bindingOperations: operationBindings,
        createRecoveryBindingOperations,
        recoverCustomizationExecution,
        revalidateSeededDiscovery,
      };
      const recovered = await recoverMissingPluginBinding({
        binding,
        recoveryContext,
      });
      if (recovered) {
        // Build the publication candidate from a fresh targeted lookup. The
        // seeded/targeted merge above is only candidate generation; it is not
        // authoritative evidence for persistence.
        const prevalidated = await revalidateRecoveryCandidate(
          recovered,
          recoveryContext,
        );
        let persisted = false;
        let stateChanged = false;
        let persistedBinding;
        // Fresh candidate validation is deliberately outside the state lock.
        // If it rejects the candidate, fall through to the original
        // structured error instead of retrying recovery indefinitely.
        const validatedForPublication = prevalidated
          ? await recoveryCandidateStillCurrent(prevalidated, recoveryContext)
          : undefined;
        if (validatedForPublication) {
          // Recheck the complete candidate, including a recursively derived
          // customization effective fingerprint, before entering the narrow
          // state-publication critical section. The graph inspector belongs
          // outside that section because it may perform Discovery for nested
          // bindings; the lock callback uses its read-only graph seam.
          const finalFullFingerprintRevision = await fullFingerprintRevision({
            descriptor,
            sourceRoot:
              validatedForPublication.evidenceRevision?.canonicalSource
              ?? path.resolve(validatedForPublication.source.path),
            entrypoint: validatedForPublication.evidenceRevision?.entrypoint,
            expectedEffectiveFingerprint:
              validatedForPublication.evidenceRevision?.effectiveFingerprint,
            replacementEvidence:
              validatedForPublication.evidenceRevision?.replacement,
            recoveryContext,
            discoverySnapshot: recoveryContext.publicationDiscoverySnapshot,
            requireEffectiveMatch: true,
          });
          if (
            !fullFingerprintRevisionMatches(
              validatedForPublication.evidenceRevision,
              finalFullFingerprintRevision,
              validatedForPublication.evidenceRevision?.replacement,
            )
          ) {
            throw new BindingError(
              "binding recovery fingerprint changed before publication",
              {
                code: "BINDING_SOURCE_SELECTION_INVALID",
                details: {
                  expected: validatedForPublication.evidenceRevision,
                  current: {
                    ...validatedForPublication.evidenceRevision,
                    ...finalFullFingerprintRevision,
                  },
                },
              },
            );
          }
          await updateJsonAtomic(statePath, EMPTY_STORE, async (store) => {
            assertBindingStore(store, statePath);
            const currentBinding = store.bindings[key];
            if (
              bindingRecordRevision(currentBinding) !== initialBindingRevision
              || !isDeepStrictEqual(
                bindingEvidenceRevisionFromBinding({
                  descriptor,
                  binding: currentBinding,
                }),
                initialBindingEvidenceRevision,
              )
            ) {
              stateChanged = true;
              return store;
            }
            const currentFilesystemRevision = await filesystemEvidenceRevision({
              sourcePath: validatedForPublication.source.path,
              targetPath: validatedForPublication.source.target,
              entrypoint: validatedForPublication.evidenceRevision?.entrypoint,
              additionalPaths: bindingEvidenceAdditionalPaths(
                descriptor,
                validatedForPublication.source.target,
                validatedForPublication.evidenceRevision?.replacement,
                statePath,
              ),
              optionalAdditionalPaths: sourceProvenancePaths(
                validatedForPublication.source.target,
              ),
            });
            if (
              !isDeepStrictEqual(
                currentFilesystemRevision,
                validatedForPublication.evidenceRevision?.filesystem,
              )
            ) {
              throw new BindingError("binding recovery evidence changed before publication", {
                code: "BINDING_SOURCE_SELECTION_INVALID",
                details: {
                  expected: validatedForPublication.evidenceRevision,
                  current: {
                    ...validatedForPublication.evidenceRevision,
                    filesystem: currentFilesystemRevision,
                  },
                },
              });
            }
            const currentFullFingerprintRevision = await fullFingerprintRevision({
              descriptor,
              sourceRoot:
                validatedForPublication.evidenceRevision?.canonicalSource
                ?? path.resolve(validatedForPublication.source.path),
              entrypoint: validatedForPublication.evidenceRevision?.entrypoint,
              expectedEffectiveFingerprint:
                validatedForPublication.evidenceRevision?.effectiveFingerprint,
              replacementEvidence:
                validatedForPublication.evidenceRevision?.replacement,
              recoveryContext,
              discoverySnapshot: recoveryContext.publicationDiscoverySnapshot,
              requireEffectiveMatch: true,
              readOnlyExecution: true,
            });
            if (
              !fullFingerprintRevisionMatches(
                validatedForPublication.evidenceRevision,
                currentFullFingerprintRevision,
                validatedForPublication.evidenceRevision?.replacement,
              )
            ) {
              throw new BindingError(
                "binding recovery fingerprint changed before publication",
                {
                  code: "BINDING_SOURCE_SELECTION_INVALID",
                  details: {
                    expected: validatedForPublication.evidenceRevision,
                    current: {
                      ...validatedForPublication.evidenceRevision,
                      ...currentFullFingerprintRevision,
                    },
                  },
                },
              );
            }
            // Candidate generation and recursive effective validation
            // completed before the lock. The critical section repeats the
            // complete read-only graph check, including the nested effective
            // token, without creating bindings or running candidate Discovery.
            store.bindings[key] = validatedForPublication;
            persistedBinding = validatedForPublication;
            persisted = true;
            return store;
          });
        }
        if (persisted) return persistedBinding;
        if (stateChanged && recoveryAttempts < MAX_RECOVERY_RETRIES) {
          return resolveBindingInternal({
            descriptor,
            context,
            statePath,
            roots,
            managerRecords,
            discoveryOptions,
            discovery,
            customizationRoot,
            discoverySnapshot: await refreshOperationDiscovery(),
            refreshDiscovery: refreshOperationDiscovery,
            recoverCustomizationExecution,
            revalidateSeededDiscovery,
            recoveryAttempts: recoveryAttempts + 1,
          });
        }
      }
    }
    if (
      new Set([
        "INVALID_BINDING_RECORD",
        "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
        "BINDING_DESCRIPTOR_ACTIVATION_MISMATCH",
        "BINDING_TARGET_MISSING",
        "BINDING_RETARGETED",
        "BINDING_SOURCE_INVALID",
        "BINDING_SOURCE_NAME_MISMATCH",
        "BINDING_SOURCE_PROVENANCE_CONFLICT",
        "BINDING_SOURCE_SELECTION_INVALID",
        "BINDING_SOURCE_PROVENANCE_MISMATCH",
        "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
        "BINDING_LOCAL_IDENTITY_MISMATCH",
        "BINDING_CUSTOMIZATION_METADATA_INVALID",
        "BINDING_CUSTOMIZATION_SOURCE_MISMATCH",
        "BINDING_SOURCE_KIND_MISMATCH",
      ]).has(error.code)
    ) {
      const invalidated = await invalidate(statePath, key, binding);
      if (!invalidated && recoveryAttempts < MAX_RECOVERY_RETRIES) {
        return resolveBindingInternal({
          descriptor,
          context,
          statePath,
          roots,
          managerRecords,
          discoveryOptions,
          discovery,
          customizationRoot,
          discoverySnapshot: await refreshOperationDiscovery(),
          refreshDiscovery: refreshOperationDiscovery,
          recoverCustomizationExecution,
          revalidateSeededDiscovery,
          recoveryAttempts: recoveryAttempts + 1,
        });
      }
    }
    throw error;
  }
}

function callerIntentOptions(options = {}) {
  return sanitizeBindingIntentOptions(options);
}

function createPublicBindingOperation(options = {}) {
  const runtime = Object.freeze({
    discovery: options.discovery,
    discoverySnapshot: options.discoverySnapshot,
    roots: options.roots,
    managerRecords: options.managerRecords ?? [],
    discoveryOptions: options.discoveryOptions ?? {},
    ...(options.discover ? { discover: options.discover } : {}),
    ...(typeof options.refreshDiscovery === "function"
      ? { refreshDiscovery: options.refreshDiscovery }
      : {}),
  });
  return createCustomizationRecoveryAdapter({
    runtime,
    selectSource: options.selectSource,
    createOperation: createBindingOperation,
  });
}

async function invokePublicBindingOperation(method, options = {}) {
  const operation = await createPublicBindingOperation(options);
  return operation[method](callerIntentOptions(options));
}

export async function bindCustomization(options = {}) {
  return invokePublicBindingOperation("bindCustomization", options);
}

export async function validateBinding(options = {}) {
  return invokePublicBindingOperation("validateBinding", options);
}

export async function resolveBinding(options = {}) {
  return invokePublicBindingOperation("resolveBinding", options);
}
