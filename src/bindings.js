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
  activeSkillInventory,
  createDiscoverySnapshot,
  discoverSkills,
  excludeSkillRootFromInventory,
} from "./discovery.js";
import { BindingError } from "./errors.js";
import { inspectCustomizationExecution } from "./execution-graph.js";
import { fingerprintFile, fingerprintPath } from "./fingerprint.js";
import { createBindingExecutionAdapter } from "./internal/binding-execution-adapter.js";
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
  } = runtime;
  const operationDiscovery = discoverySnapshot ?? createDiscoverySnapshot({
    discovery,
    roots,
    managerRecords,
    options: operationDiscoveryOptions,
    ...(discover ? { discover } : {}),
  });
  const withOperationContext = (options = {}) => {
    const {
      discovery: _discovery,
      discoverySnapshot: _discoverySnapshot,
      roots: _roots,
      managerRecords: _managerRecords,
      discoveryOptions: _discoveryOptions,
      discover: _discover,
      runtime: _runtime,
      ...intent
    } = options;
    return {
      ...intent,
      roots,
      managerRecords,
      ...(options.selectSource === undefined && selectSource
        ? { selectSource }
        : {}),
      discoverySnapshot: operationDiscovery,
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
  let confirmedTarget;
  let sourceTarget;
  try {
    [confirmedTarget, sourceTarget] = await Promise.all([
      realpath(confirmedSelection.copy?.path),
      realpath(sourceDirectory),
    ]);
  } catch {
    confirmedTarget = undefined;
    sourceTarget = undefined;
  }
  const copy = group.copies.find(
    (candidate) =>
      path.resolve(candidate.realPath ?? candidate.path) === confirmedTarget
      && confirmedTarget === sourceTarget,
  );
  const confirmation = confirmedSelection.confirmation
    ?? [...(confirmedSelection.evidence ?? [])]
      .reverse()
      .find((item) => item.kind === "confirmation");
  if (!(
    confirmedSelection.name === group.name
    && copy
    && typeof confirmedSelection.provenance === "string"
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
  return {
    decision: selectionDecision,
    selection: {
      name: group.name,
      copy: structuredClone(confirmedSelection.copy),
      provenance: selectionDecision.selectedProvenance,
      confirmation: structuredClone(confirmation),
    },
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
    throw new BindingError(`bound customization metadata is invalid: ${error.message}`, {
      code: "BINDING_CUSTOMIZATION_METADATA_INVALID",
    });
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
  requireLocalIdentityMatch = true,
}) {
  const resolved = path.resolve(sourcePath);
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new BindingError(`binding source is unavailable: ${resolved}`, {
      code: "BINDING_SOURCE_INVALID",
    });
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
  const declaredName = sourceMetadata?.declaredName
    ?? await readSkillName(entrypoint).catch(() => undefined);
  if (declaredName !== descriptor.source.skill_name) {
    throw new BindingError(
      `binding source declares ${declaredName ?? "no name"}; expected ${descriptor.source.skill_name}`,
      { code: "BINDING_SOURCE_NAME_MISMATCH" },
    );
  }
  let discovery;
  try {
    const discoveryInput = sourcePolicy.discoveryInput({ resolved, sourceRoot });
    if (discoverySnapshot) {
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
    throw new BindingError(`binding source is not a discoverable skill: ${error.message}`, {
      code: "BINDING_SOURCE_INVALID",
      details: error.details,
    });
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
    throw new BindingError(`binding source cannot be fingerprinted: ${error.message}`, {
      code: "BINDING_SOURCE_INVALID",
    });
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
}

const BINDING_OPERATIONS = createBindingExecutionAdapter({
  bindingKey,
  readBindingStore,
  resolveBinding: resolveBindingInternal,
  validateBinding: validateBindingInternal,
});

function matchesCustomizationCopy(source, group, copy) {
  return copy.classification === "customization"
    && group.name === source.skill_name
    && copy.customization?.id === source.id
    && copy.customization?.type === source.type
    && copy.customization?.license === source.license;
}

async function recoverStandardFingerprint({ copy }) {
  return fingerprintPath(copy.path).catch(() => undefined);
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
    roots,
    managerRecords,
    discoverySnapshot,
    bindingOperations = BINDING_OPERATIONS,
  } = recoveryContext;
  if (!matchesCustomizationCopy(descriptor.source, group, copy)) return undefined;
  const execution = await inspectCustomizationExecution({
    descriptorPath: path.join(copy.path, "customization.json"),
    context,
    statePath,
    roots,
    managerRecords,
    discoverySnapshot,
    bindings: bindingOperations,
  }).catch(() => undefined);
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
  } catch {
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
    ? await realpath(customizationRoot).catch(() => path.resolve(customizationRoot))
    : undefined;
  const findMatches = async (discovery) => {
    const matches = [];
    for (const group of discovery.groups) {
      if (group.name !== descriptor.source.skill_name) continue;
      for (const copy of group.copies) {
        if (copy.active === false) continue;
        if (
          excludedRoot
          && path.resolve(copy.realPath ?? copy.path) === excludedRoot
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
          matches.push({ group, copy, provenance });
        }
      }
    }
    return matches;
  };
  const mergeMatches = async (seededMatches, targetedMatches) => {
    const merged = new Map();
    for (const candidate of [...seededMatches, ...targetedMatches]) {
      const candidatePath = candidate.copy.realPath ?? candidate.copy.path;
      const canonicalPath = path.resolve(
        await realpath(candidatePath).catch(() => candidatePath),
      );
      const previous = merged.get(canonicalPath);
      if (!previous) {
        merged.set(canonicalPath, candidate);
        continue;
      }
      const provenanceAgrees = previous.provenance === candidate.provenance;
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
  const { alias: _alias, selection: _selection, ...stableSource } = binding.source;
  const source = {
    ...stableSource,
    path: path.resolve(copy.path),
    target: await realpath(copy.path),
  };
  return { ...binding, source, updatedAt: new Date().toISOString() };
}

async function assertReplacementActivation({
  descriptor,
  customizationRoot,
  discoverySnapshot,
}) {
  if (descriptor.activation.mode !== "replace") return;
  const discovery = await discoverySnapshot.inventory();
  let activeSkills = activeSkillInventory(discovery);
  if (customizationRoot) {
    activeSkills = await excludeSkillRootFromInventory(activeSkills, customizationRoot);
  }
  const sameName = activeSkills.filter(({ name }) => name === descriptor.name);
  if (sameName.length > 1) {
    throw new BindingError("replacement activation is ambiguous in this host context", {
      code: "AMBIGUOUS_REPLACEMENT",
      details: sameName,
    });
  }
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
  confirmedSelection,
  selectSource,
  requestScope,
  discovery,
  discoverySnapshot,
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
  const store = await readBindingStore(statePath);
  if (store.bindings[key]) {
    return resolveBindingInternal({
      descriptor,
      context,
      statePath,
      roots,
      managerRecords,
      customizationRoot,
      discoverySnapshot: operationDiscovery,
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
  });
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
  const sourcePolicy = bindingSourcePolicyFor(descriptor.source.kind);
  await confirmOrFail(
    confirm,
    { descriptor, context, source: classified, inspection },
    "FIRST_USE_CONFIRMATION_REQUIRED",
    "source binding was not confirmed",
  );
  if (descriptor.activation.mode === "replace") {
    await assertReplacementActivation({
      descriptor,
      customizationRoot,
      discoverySnapshot: operationDiscovery,
    });
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
  const timestamp = now();
  const binding = {
    customization: descriptor.id,
    context,
    scope: classified.scope,
    origin: classified.origin,
    activation: descriptor.activation,
    source: {
      path: path.resolve(sourcePath),
      target: classified.targetPath,
      ...(classified.aliasPath ? { alias: classified.aliasPath } : {}),
      skillName: inspection.declaredName,
      kind: descriptor.source.kind,
      ...(sourcePolicy.bindingFields?.({ inspection }) ?? {}),
      fingerprint: inspection.fingerprint,
      provenance: inspection.provenance,
      ...(inspection.pluginIdentity
        ? { pluginIdentity: inspection.pluginIdentity }
        : {}),
      ...(inspection.pluginCache?.scope === classified.scope
        ? { pluginCache: inspection.pluginCache }
        : {}),
      ...(inspection.selection ? { selection: inspection.selection } : {}),
      confirmation: inspection.selection
        ? "provenance-confirmed"
        : inspection.provenance.length === 0
          ? "user-confirmed"
          : "evidence-confirmed",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let persistedBinding;
  let created = false;
  await updateJsonAtomic(statePath, EMPTY_STORE, async (current) => {
    assertBindingStore(current, statePath);
    if (current.bindings[key]) {
      persistedBinding = current.bindings[key];
      return current;
    }
    current.bindings[key] = binding;
    persistedBinding = binding;
    created = true;
    return current;
  });
  if (created) return binding;
  return validateBindingInternal({
    descriptor,
    binding: persistedBinding,
    roots,
    managerRecords,
    customizationRoot,
    discoverySnapshot: operationDiscovery,
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
  discovery,
  discoverySnapshot,
}) {
  assertValidDescriptor(descriptor);
  if (!binding || typeof binding !== "object" || !binding.source) {
    throw new BindingError("binding record is incomplete", {
      code: "INVALID_BINDING_RECORD",
    });
  }
  if (
    binding.customization !== descriptor.id ||
    binding.source.skillName !== descriptor.source.skill_name ||
    binding.source.kind !== descriptor.source.kind
  ) {
    throw new BindingError("binding source identity no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  }
  if (
    binding.activation?.mode !== descriptor.activation.mode ||
    binding.activation?.precedence !== descriptor.activation.precedence
  ) {
    throw new BindingError("binding activation no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_ACTIVATION_MISMATCH",
    });
  }
  bindingSourcePolicyFor(descriptor.source.kind).validateBinding({ descriptor, binding });
  const operationDiscovery = bindingDiscoverySnapshot({
    discovery,
    discoverySnapshot,
    roots,
    managerRecords,
  });
  await assertReplacementActivation({
    descriptor,
    customizationRoot,
    discoverySnapshot: operationDiscovery,
  });

  const lookupPath = binding.source.alias ?? binding.source.path;
  let currentTarget;
  try {
    currentTarget = await realpath(lookupPath);
  } catch {
    throw new BindingError(`binding target is missing: ${lookupPath}`, {
      code: "BINDING_TARGET_MISSING",
    });
  }
  if (path.resolve(currentTarget) !== path.resolve(binding.source.target)) {
    throw new BindingError(`binding symlink was retargeted: ${lookupPath}`, {
      code: "BINDING_RETARGETED",
      details: { previous: binding.source.target, current: currentTarget },
    });
  }
  const inspection = await inspectBindingSource({
    descriptor,
    sourcePath: lookupPath,
    roots,
    managerRecords,
    confirmedSelection: binding.source.selection,
    discoverySnapshot: operationDiscovery,
    requireLocalIdentityMatch: false,
  });
  return { binding, inspection, currentTarget };
}

async function resolveBindingInternal({
  descriptor,
  context,
  statePath = bindingStorePath(),
  roots,
  customizationRoot,
  managerRecords = [],
  discovery,
  discoverySnapshot,
}) {
  assertValidDescriptor(descriptor);
  const operationDiscovery = bindingDiscoverySnapshot({
    discovery,
    discoverySnapshot,
    roots,
    managerRecords,
  });
  const operationBindings = createBindingOperation({
    runtime: {
      discoverySnapshot: operationDiscovery,
      roots,
      managerRecords,
    },
  });
  const store = await readBindingStore(statePath);
  const key = bindingKey(descriptor.id, context);
  const binding = store.bindings[key];
  if (!binding) {
    throw new BindingError(`no binding for ${descriptor.id} in ${context}`, {
      code: "BINDING_NOT_FOUND",
    });
  }
  try {
    return (
      await validateBindingInternal({
        descriptor,
        binding,
        roots,
        managerRecords,
        customizationRoot,
        discoverySnapshot: operationDiscovery,
      })
    ).binding;
  } catch (error) {
    if (error.code === "BINDING_TARGET_MISSING") {
      const recoveryContext = {
        descriptor,
        context,
        statePath,
        roots,
        managerRecords,
        customizationRoot,
        discoverySnapshot: operationDiscovery,
        bindingOperations: createBindingExecutionAdapter(operationBindings),
      };
      const recovered = await recoverMissingPluginBinding({
        binding,
        recoveryContext,
      });
      if (recovered) {
        let persisted = false;
        await updateJsonAtomic(statePath, EMPTY_STORE, async (store) => {
          assertBindingStore(store, statePath);
          if (!isDeepStrictEqual(store.bindings[key], binding)) return store;
          store.bindings[key] = recovered;
          persisted = true;
          return store;
        });
        if (persisted) return recovered;
        return resolveBindingInternal({
          descriptor,
          context,
          statePath,
          roots,
          managerRecords,
          customizationRoot,
          discoverySnapshot: operationDiscovery,
        });
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
      if (!invalidated) {
        return resolveBindingInternal({
          descriptor,
          context,
          statePath,
          roots,
          managerRecords,
          customizationRoot,
          discoverySnapshot: operationDiscovery,
        });
      }
    }
    throw error;
  }
}

function callerIntentOptions(options = {}) {
  const {
    discovery: _discovery,
    discoverySnapshot: _discoverySnapshot,
    roots: _roots,
    managerRecords: _managerRecords,
    discoveryOptions: _discoveryOptions,
    discover: _discover,
    runtime: _runtime,
    ...intent
  } = options;
  return intent;
}

export async function bindCustomization(options = {}) {
  const operation = createBindingOperation({
    runtime: {
      discovery: options.discovery,
      discoverySnapshot: options.discoverySnapshot,
      roots: options.roots,
      managerRecords: options.managerRecords,
      discoveryOptions: options.discoveryOptions,
    },
  });
  return operation.bindCustomization(callerIntentOptions(options));
}

export async function validateBinding(options = {}) {
  const operation = createBindingOperation({
    runtime: {
      discovery: options.discovery,
      discoverySnapshot: options.discoverySnapshot,
      roots: options.roots,
      managerRecords: options.managerRecords,
      discoveryOptions: options.discoveryOptions,
    },
  });
  return operation.validateBinding(callerIntentOptions(options));
}

export async function resolveBinding(options = {}) {
  const operation = createBindingOperation({
    runtime: {
      discovery: options.discovery,
      discoverySnapshot: options.discoverySnapshot,
      roots: options.roots,
      managerRecords: options.managerRecords,
      discoveryOptions: options.discoveryOptions,
    },
  });
  return operation.resolveBinding(callerIntentOptions(options));
}
