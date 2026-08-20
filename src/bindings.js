import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assertValidDescriptor, readDescriptor } from "./descriptor.js";
import { discoverSkills } from "./discovery.js";
import { BindingError } from "./errors.js";
import { inspectCustomizationExecution } from "./execution-graph.js";
import { fingerprintFile, fingerprintPath } from "./fingerprint.js";
import {
  generateLocalIdentity,
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "./normalization.js";
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

function contains(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchingRoot(targetPath, roots) {
  return roots
    .filter((candidate) => candidate.path && contains(candidate.path, targetPath))
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

async function confirmedSelectionFor(group, confirmedSelection, sourceDirectory) {
  if (!confirmedSelection) {
    if (group.conflict) {
      throw new BindingError("binding source provenance is ambiguous", {
        code: "BINDING_SOURCE_PROVENANCE_CONFLICT",
        details: group.provenance,
      });
    }
    return undefined;
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
  const valid =
    confirmedSelection.name === group.name
    && copy
    && typeof confirmedSelection.provenance === "string"
    && confirmedSelection.copy?.provenance?.includes(
      confirmedSelection.provenance,
    )
    && copy.provenance.includes(confirmedSelection.provenance)
    && confirmation?.kind === "confirmation"
    && confirmation.path === confirmedSelection.copy?.path;
  if (!valid) {
    throw new BindingError(
      "confirmed source selection does not match current discovery evidence",
      {
        code: "BINDING_SOURCE_SELECTION_INVALID",
        details: { confirmedSelection, currentProvenance: group.provenance },
      },
    );
  }
  return {
    name: group.name,
    copy: structuredClone(confirmedSelection.copy),
    provenance: confirmedSelection.provenance,
    confirmation: structuredClone(confirmation),
  };
}

async function inspectBindingSource({
  descriptor,
  sourcePath,
  roots,
  managerRecords,
  confirmedSelection,
  requireLocalIdentityMatch = true,
}) {
  const resolved = path.resolve(sourcePath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new BindingError(`binding source is unavailable: ${resolved}`, {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  const entrypoint = info.isDirectory() ? path.join(resolved, "SKILL.md") : resolved;
  if (!info.isDirectory() && path.basename(entrypoint) !== "SKILL.md") {
    throw new BindingError("a file binding source must be named SKILL.md", {
      code: "BINDING_SOURCE_INVALID",
    });
  }
  const sourceRoot = await realpath(
    info.isDirectory() ? resolved : path.dirname(entrypoint),
  );
  const declaredName = await readSkillName(entrypoint).catch(() => undefined);
  if (declaredName !== descriptor.source.skill_name) {
    throw new BindingError(
      `binding source declares ${declaredName ?? "no name"}; expected ${descriptor.source.skill_name}`,
      { code: "BINDING_SOURCE_NAME_MISMATCH" },
    );
  }
  let discovery;
  try {
    discovery = await discoverSkills({
      input: descriptor.source.kind === "customization" ? sourceRoot : resolved,
      roots,
      managerRecords,
    });
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
  const selection = await confirmedSelectionFor(
    group,
    confirmedSelection,
    descriptor.source.kind === "customization"
      ? sourceRoot
      : path.dirname(entrypoint),
  );
  const sourceCopies = group.copies.filter(
    (copy) => path.resolve(copy.realPath ?? copy.path) === sourceRoot,
  );
  const sourcePluginEvidence = sourceCopies.flatMap((copy) =>
    (copy.evidence ?? []).filter(({ kind }) => kind === "plugin")
  );
  const pluginIdentities = [...new Set([
    ...sourceCopies.map(({ pluginIdentity }) => pluginIdentity),
    ...sourcePluginEvidence
      .filter(({ identity }) => typeof identity === "string")
      .map(({ identity }) => identity),
  ].filter(Boolean))];
  const bindingPluginIdentity = selection
    && pluginIdentities.includes(selection.provenance)
    ? selection.provenance
    : pluginIdentities.length === 1
      ? pluginIdentities[0]
      : undefined;
  const bindingPluginCaches = [...new Map(
    sourcePluginEvidence
      .filter(({ identity, cache }) =>
        identity === bindingPluginIdentity
        && cache?.kind === "versioned"
      )
      .map(({ cache }) => [JSON.stringify(cache), cache]),
  ).values()];
  const bindingPluginCache = bindingPluginCaches.length === 1
    ? bindingPluginCaches[0]
    : undefined;
  let repository;
  let upstreamPath;
  if (descriptor.source.kind === "repository") {
    repository = normalizeRepositoryUrl(descriptor.source.repository);
    upstreamPath = normalizeUpstreamEntrypoint(descriptor.source.upstream_path);
    const repositoryProvenance = `repository:${repository}`;
    const expectedProvenance = `repository:${repository}#${upstreamPath}`;
    if (
      selection
      && selection.provenance !== repositoryProvenance
      && selection.provenance !== expectedProvenance
    ) {
      throw new BindingError(
        "confirmed source provenance does not match the descriptor",
        {
          code: "BINDING_SOURCE_PROVENANCE_MISMATCH",
          details: {
            expected: expectedProvenance,
            actual: selection.provenance,
          },
        },
      );
    }
    if (!selection) {
      const repositoryEvidence = group.evidence
        .filter((item) => item.repository)
        .map((item) => ({
          repository: normalizeRepositoryUrl(item.repository),
          upstreamPath: normalizeUpstreamEntrypoint(
            item.upstream_path ?? item.upstreamPath,
          ),
          kind: item.kind,
        }));
      const conflictingRepositories = repositoryEvidence.filter(
        (item) => item.repository !== repository,
      );
      if (conflictingRepositories.length > 0) {
        throw new BindingError("binding source repository does not match the descriptor", {
          code: "BINDING_SOURCE_PROVENANCE_MISMATCH",
          details: { expected: repository, actual: conflictingRepositories },
        });
      }
      const observedPaths = [
        ...new Set(
          repositoryEvidence
            .filter((item) => item.repository === repository)
            .map((item) => item.upstreamPath)
            .filter(Boolean),
        ),
      ];
      if (observedPaths.some((value) => value !== upstreamPath)) {
        throw new BindingError(
          "binding source upstream entrypoint does not match the descriptor",
          {
            code: "BINDING_SOURCE_UPSTREAM_PATH_MISMATCH",
            details: { expected: upstreamPath, actual: observedPaths },
          },
        );
      }
    }
  }
  let customization;
  if (descriptor.source.kind === "customization") {
    if (!info.isDirectory()) {
      throw new BindingError("a customization source must be bound by its directory", {
        code: "BINDING_SOURCE_INVALID",
      });
    }
    try {
      customization = await readDescriptor(path.join(sourceRoot, "customization.json"));
    } catch (error) {
      throw new BindingError(`bound customization metadata is invalid: ${error.message}`, {
        code: "BINDING_CUSTOMIZATION_METADATA_INVALID",
      });
    }
    if (
      customization.id !== descriptor.source.id
      || customization.type !== descriptor.source.type
      || customization.name !== descriptor.source.skill_name
      || customization.license !== descriptor.source.license
    ) {
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
  } else if (group.copies.some((copy) => copy.classification === "customization")) {
    throw new BindingError("a customization candidate requires source.kind customization", {
      code: "BINDING_SOURCE_KIND_MISMATCH",
    });
  }
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
  const localIdentity = generateLocalIdentity({
    skillName: descriptor.source.skill_name,
    fingerprint: entrypointFingerprint,
  });
  if (
    descriptor.source.kind === "local" &&
    requireLocalIdentityMatch &&
    localIdentity !== descriptor.source.identity
  ) {
    throw new BindingError("binding source does not match the descriptor local identity", {
      code: "BINDING_LOCAL_IDENTITY_MISMATCH",
      details: { expected: descriptor.source.identity, actual: localIdentity },
    });
  }
  return {
    declaredName,
    entrypoint,
    fingerprint,
    entrypointFingerprint,
    localIdentity,
    ...(repository ? { repository, upstreamPath } : {}),
    ...(customization
      ? {
          customization: {
            id: customization.id,
            type: customization.type,
            license: customization.license,
          },
        }
      : {}),
    provenance: selection ? [selection.provenance] : group.provenance,
    evidence: group.evidence,
    selection,
    ...(bindingPluginIdentity
      ? { pluginIdentity: bindingPluginIdentity }
      : {}),
    ...(bindingPluginCache
      ? { pluginCache: structuredClone(bindingPluginCache) }
      : {}),
  };
}

function compatibleProvenance(descriptor, copy) {
  const repository = descriptor.source.kind === "repository"
    ? normalizeRepositoryUrl(descriptor.source.repository)
    : undefined;
  const upstreamPath = descriptor.source.kind === "repository"
    ? normalizeUpstreamEntrypoint(descriptor.source.upstream_path)
    : undefined;
  return copy.provenance.find((identity) => {
    if (repository) {
      return identity === `repository:${repository}`
        || identity === `repository:${repository}#${upstreamPath}`;
    }
    return identity === descriptor.source.identity
      || identity === `local:${descriptor.source.identity}`;
  });
}

const BINDING_OPERATIONS = Object.freeze({
  bindingKey,
  readBindingStore,
  resolveBinding,
  validateBinding,
});

function matchesCustomizationCopy(source, group, copy) {
  return copy.classification === "customization"
    && group.name === source.skill_name
    && copy.customization?.id === source.id
    && copy.customization?.type === source.type
    && copy.customization?.license === source.license;
}

async function recoveryFingerprint({
  descriptor,
  group,
  copy,
  context,
  statePath,
  roots,
  managerRecords,
  activeSkills,
}) {
  if (descriptor.source.kind !== "customization") {
    return fingerprintPath(copy.path).catch(() => undefined);
  }
  if (!matchesCustomizationCopy(descriptor.source, group, copy)) return undefined;
  const execution = await inspectCustomizationExecution({
    descriptorPath: path.join(copy.path, "customization.json"),
    context,
    statePath,
    roots,
    managerRecords,
    activeSkills,
    bindings: BINDING_OPERATIONS,
  }).catch(() => undefined);
  return execution?.status === "maintenance-required"
    ? undefined
    : execution?.effectiveFingerprint;
}

async function recoverMissingPluginBinding({
  descriptor,
  binding,
  context,
  statePath,
  roots,
  managerRecords,
  activeSkills,
}) {
  const { pluginCache, pluginIdentity } = binding.source;
  if (
    !pluginIdentity
    || pluginCache?.kind !== "versioned"
    || pluginCache.scope !== binding.scope
  ) return undefined;
  // A cache path is replaceable local state; continuity is safe only for one
  // stable plugin identity and one already reviewed effective fingerprint.
  let discovery;
  try {
    discovery = await discoverSkills({
      input: descriptor.source.skill_name,
      roots,
      managerRecords,
    });
  } catch (error) {
    if (error.code === "NO_LOCAL_COPY") return undefined;
    throw error;
  }
  const matches = [];
  for (const group of discovery.groups) {
    for (const copy of group.copies) {
      if (copy.pluginIdentity !== pluginIdentity || copy.scope !== pluginCache.scope) continue;
      const compatibleCache = copy.evidence.some(
        ({ kind, identity, cache }) =>
          kind === "plugin"
          && identity === pluginIdentity
          && cache?.kind === "versioned"
          && cache.scope === pluginCache.scope,
      );
      if (!compatibleCache) continue;
      const effectiveFingerprint = await recoveryFingerprint({
        descriptor,
        group,
        copy,
        context,
        statePath,
        roots,
        managerRecords,
        activeSkills,
      });
      if (effectiveFingerprint !== descriptor.source.effective_fingerprint) continue;
      const provenance = compatibleProvenance(descriptor, copy);
      if (provenance || ["local", "customization"].includes(descriptor.source.kind)) {
        matches.push({ group, copy, provenance });
      }
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

function assertReplacementInventory(descriptor, activeSkills) {
  if (descriptor.activation.mode !== "replace") return;
  if (!Array.isArray(activeSkills)) {
    throw new BindingError("replacement requires the active host inventory", {
      code: "REPLACEMENT_INVENTORY_REQUIRED",
    });
  }
  const sameName = activeSkills.filter(({ name }) => name === descriptor.name);
  if (sameName.length > 1) {
    throw new BindingError("replacement activation is ambiguous in this host context", {
      code: "AMBIGUOUS_REPLACEMENT",
      details: sameName,
    });
  }
}

export async function bindCustomization({
  descriptor,
  sourcePath,
  context,
  statePath = bindingStorePath(),
  roots,
  requestedScope,
  interactive = Boolean(process.stdin.isTTY),
  confirm,
  confirmReplace,
  activeSkills,
  managerRecords = [],
  confirmedSelection,
  now = () => new Date().toISOString(),
}) {
  assertValidDescriptor(descriptor);
  if (typeof context !== "string" || !context.trim()) {
    throw new BindingError("binding context is required", { code: "BINDING_CONTEXT_REQUIRED" });
  }
  const key = bindingKey(descriptor.id, context);
  const store = await readBindingStore(statePath);
  if (store.bindings[key]) {
    return resolveBinding({
      descriptor,
      context,
      statePath,
      roots,
      managerRecords,
      activeSkills,
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
  });
  const classified = await classifyBindingScope({ sourcePath, roots, requestedScope });
  await confirmOrFail(
    confirm,
    { descriptor, context, source: classified, inspection },
    "FIRST_USE_CONFIRMATION_REQUIRED",
    "source binding was not confirmed",
  );
  if (descriptor.activation.mode === "replace") {
    assertReplacementInventory(descriptor, activeSkills);
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
      ...(descriptor.source.kind === "repository"
        ? {
            repository: inspection.repository,
            upstreamPath: inspection.upstreamPath,
          }
        : descriptor.source.kind === "local"
          ? { localIdentity: inspection.localIdentity }
          : { customization: inspection.customization }),
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
  return validateBinding({
    descriptor,
    binding: persistedBinding,
    roots,
    managerRecords,
    activeSkills,
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

export async function validateBinding({
  descriptor,
  binding,
  roots,
  managerRecords = [],
  activeSkills,
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
  if (descriptor.source.kind === "repository") {
    const expectedRepository = normalizeRepositoryUrl(descriptor.source.repository);
    const expectedUpstreamPath = normalizeUpstreamEntrypoint(
      descriptor.source.upstream_path,
    );
    if (
      binding.source.repository !== expectedRepository ||
      binding.source.upstreamPath !== expectedUpstreamPath
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
  } else if (
    descriptor.source.kind === "local"
    && binding.source.localIdentity !== descriptor.source.identity
  ) {
    throw new BindingError("binding local source no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  } else if (
    descriptor.source.kind === "customization"
    && (
      binding.source.customization?.id !== descriptor.source.id
      || binding.source.customization?.type !== descriptor.source.type
      || binding.source.customization?.license !== descriptor.source.license
    )
  ) {
    throw new BindingError("binding customization source no longer matches the descriptor", {
      code: "BINDING_DESCRIPTOR_SOURCE_MISMATCH",
    });
  }
  assertReplacementInventory(descriptor, activeSkills);

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
    requireLocalIdentityMatch: false,
  });
  return { binding, inspection, currentTarget };
}

export async function resolveBinding({
  descriptor,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  activeSkills,
}) {
  assertValidDescriptor(descriptor);
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
      await validateBinding({
        descriptor,
        binding,
        roots,
        managerRecords,
        activeSkills,
      })
    ).binding;
  } catch (error) {
    if (error.code === "BINDING_TARGET_MISSING") {
      const recovered = await recoverMissingPluginBinding({
        descriptor,
        binding,
        context,
        statePath,
        roots,
        managerRecords,
        activeSkills,
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
        return resolveBinding({
          descriptor,
          context,
          statePath,
          roots,
          managerRecords,
          activeSkills,
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
        return resolveBinding({
          descriptor,
          context,
          statePath,
          roots,
          managerRecords,
          activeSkills,
        });
      }
    }
    throw error;
  }
}
