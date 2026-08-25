import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  matchesCustomizationSource,
  readCheckedDescriptor,
} from "./descriptor.js";
import {
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "./fingerprint.js";
import { createBindingExecutionAdapter } from "./internal/binding-execution-adapter.js";
import { attachPublicationToken, publicationTokenFor } from "./internal/publication-token.js";
import { statePathExclusions } from "./paths.js";
import { reconcileCustomization } from "./reconcile.js";

export const MAX_CUSTOMIZATION_DEPTH = 32;

function handlerFor(descriptor, root, reason, detail) {
  const skill = descriptor.type === "fork" ? "skill-fork" : "skill-overlay";
  return {
    skill,
    customizationId: descriptor.id,
    path: root,
    reason,
    action: `Call the Skill tool with ${skill}, accept or repair the maintenance decision, then rerun preflight.`,
    ...(detail ? { detail } : {}),
  };
}

function maintenance(descriptor, root, reason, detail) {
  return {
    status: "maintenance-required",
    effectiveFingerprint: null,
    steps: [],
    advisories: [],
    maintenanceHandler: handlerFor(descriptor, root, reason, detail),
  };
}

function effectiveFingerprint(descriptor, ownedFingerprint, sourceFingerprint) {
  const executionRole = descriptor.type === "fork" ? "workflow" : "delta";
  const executionSelector = [executionRole, descriptor.customization];
  if (descriptor.type === "fork") {
    return fingerprintValues(
      [descriptor.id, ...executionSelector, ownedFingerprint],
      "skill-customization-fork-effective-v1",
    );
  }
  return fingerprintValues(
    [descriptor.id, ...executionSelector, sourceFingerprint, ownedFingerprint],
    "skill-customization-overlay-effective-v1",
  );
}

function publicationPaths(...values) {
  return [...new Set(values.flat().filter((value) => typeof value === "string"))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

// Publication evidence is an internal hand-off between Preflight and Binding
// recovery.  Keep it off the result interface: callers receive an execution
// plan, not the implementation details of the CAS that made it safe.
function withPublicationToken(result, token) {
  return attachPublicationToken(result, token);
}

function bindingPublicationPaths(binding) {
  return binding.evidenceRevision?.filesystem?.entries
    ?.map(({ path: evidencePath }) => evidencePath)
    ?? [];
}

function bindingPublicationStateTreePaths(binding) {
  return binding.evidenceRevision?.filesystem?.stateTreePaths ?? [];
}

async function sourceRoot(binding) {
  const lookup = binding.source.alias ?? binding.source.path;
  const target = await realpath(lookup);
  const info = await lstat(target);
  return info.isDirectory() ? target : path.dirname(target);
}

async function checkedCustomizationSource(source, root) {
  const descriptorPath = path.join(root, "customization.json");
  const checked = await readCheckedDescriptor(descriptorPath);
  return {
    descriptorPath,
    checked,
    matches: matchesCustomizationSource(source, checked.descriptor),
  };
}

async function forkTrackingAdvisory(descriptor, {
  customizationRoot,
  context,
  statePath,
  roots,
  managerRecords,
  discoverySnapshot,
  depth,
  activeIds,
  activePaths,
  bindings,
}) {
  let store;
  try {
    store = await bindings.readBindingStore();
  } catch (error) {
    return {
      code: "tracking-state-invalid",
      message: "The optional fork tracking state is unreadable or invalid; fork execution is unaffected.",
      detail: error.message,
    };
  }
  const binding = store.bindings[bindings.bindingKey(descriptor.id, context)];
  if (!binding) return undefined;
  const lookup = binding.source?.alias ?? binding.source?.path;
  if (!lookup) {
    return {
      code: "tracking-binding-invalid",
      message: "The optional fork tracking binding is incomplete; fork execution is unaffected.",
    };
  }
  try {
    let validated;
    try {
      validated = await bindings.validateBinding({
        descriptor,
        binding,
        customizationRoot,
      });
    } catch (error) {
      if (error.code === "BINDING_SOURCE_FINGERPRINT_MISMATCH") {
        return {
          code: "tracking-source-drift",
          message: "The optional tracked source differs from its reviewed or confirmed fingerprint; adoption or rebase remains explicit.",
          expectedFingerprint: descriptor.source.effective_fingerprint,
          actualFingerprint: error.details?.actualFingerprint,
        };
      }
      return {
        code: "tracking-binding-invalid",
        message: "The optional fork tracking binding is invalid; fork execution is unaffected.",
        detail: error.message,
      };
    }
    const target = await realpath(lookup);
    const info = await lstat(target);
    const root = info.isDirectory() ? target : path.dirname(target);
    const expected = descriptor.source.effective_fingerprint;
    let current;
    if (descriptor.source.kind === "customization") {
      const nested = await checkedCustomizationSource(descriptor.source, root);
      if (!nested.matches) {
        return {
          code: "tracking-binding-invalid",
          message: "The optional fork tracking binding does not match the reviewed customization identity; fork execution is unaffected.",
        };
      }
      const tracked = await visit({
        descriptorPath: nested.descriptorPath,
        context,
        statePath,
        roots,
        managerRecords,
        discoverySnapshot,
        depth: depth + 1,
        activeIds,
        activePaths,
        bindings,
        checkedDescriptor: nested.checked,
      });
      if (tracked.status === "maintenance-required") {
        return {
          code: "tracking-source-drift",
          message: "The optional tracked customization no longer has the reviewed effective execution graph; adoption or rebase remains explicit.",
          expectedFingerprint: expected,
          detail: tracked.maintenanceHandler?.detail
            ?? tracked.maintenanceHandler?.reason,
        };
      }
      current = tracked.effectiveFingerprint;
    } else {
      current = validated?.inspection.fingerprint ?? await fingerprintPath(root, {
        excludedPaths: statePathExclusions(statePath),
      });
    }
    if (current !== expected) {
      return {
        code: "tracking-source-drift",
        message: "The optional tracked source differs from its reviewed or confirmed fingerprint; adoption or rebase remains explicit.",
        expectedFingerprint: expected,
        actualFingerprint: current,
      };
    }
  } catch (error) {
    return {
      code: "tracking-source-unavailable",
      message: "The optional tracked source is unavailable; fork execution is unaffected.",
      detail: error.message,
    };
  }
  return undefined;
}

async function visit({
  descriptorPath,
  context,
  statePath,
  roots,
  managerRecords,
  discoverySnapshot,
  depth,
  activeIds,
  activePaths,
  bindings,
  checkedDescriptor,
}) {
  const checked = checkedDescriptor ?? await readCheckedDescriptor(descriptorPath);
  const descriptor = checked.descriptor;
  const root = checked.location.canonicalRoot;
  if (depth > MAX_CUSTOMIZATION_DEPTH) {
    return maintenance(
      descriptor,
      root,
      "depth-limit",
      `Customization graphs are limited to ${MAX_CUSTOMIZATION_DEPTH} levels.`,
    );
  }
  if (activeIds.has(descriptor.id) || activePaths.has(root)) {
    return maintenance(
      descriptor,
      root,
      "cycle-detected",
      "The recursive source graph repeats a stable customization ID or canonical path.",
    );
  }

  const nextIds = new Set(activeIds).add(descriptor.id);
  const nextPaths = new Set(activePaths).add(root);
  let ownedFingerprint;
  try {
    ownedFingerprint = await payloadFingerprint(root);
  } catch (error) {
    return maintenance(descriptor, root, "owned-payload-invalid", error.message);
  }
  if (ownedFingerprint !== descriptor.owned_payload.reviewed_fingerprint) {
    return maintenance(
      descriptor,
      root,
      "owned-payload-drift",
      "Runtime-owned files differ from the reviewed owned-payload fingerprint.",
    );
  }

  if (descriptor.type === "fork") {
    try {
      await reconcileCustomization({ descriptor, customizationRoot: root, statePath });
    } catch (error) {
      return maintenance(descriptor, root, "fork-payload-or-provenance-drift", error.message);
    }
    const advisory = await forkTrackingAdvisory(descriptor, {
      customizationRoot: root,
      context,
      statePath,
      roots,
      managerRecords,
      discoverySnapshot,
      depth,
      activeIds: nextIds,
      activePaths: nextPaths,
      bindings,
    });
    const advisories = advisory ? [advisory] : [];
    return withPublicationToken({
      status: advisories.length > 0 ? "ready-with-advisory" : "ready",
      effectiveFingerprint: effectiveFingerprint(descriptor, ownedFingerprint),
      steps: [{
        role: "workflow",
        path: path.join(root, descriptor.customization),
        root,
        customizationId: descriptor.id,
      }],
      advisories,
      maintenanceHandler: null,
    }, { paths: [root] });
  }

  let binding;
  try {
    binding = await bindings.resolveBinding({
      descriptor,
      context,
      customizationRoot: root,
    });
  } catch (error) {
    if (error.code === "BINDING_SOURCE_FINGERPRINT_MISMATCH") {
      return maintenance(
        descriptor,
        root,
        "source-drift",
        "The full source effective fingerprint changed.",
      );
    }
    return maintenance(descriptor, root, "binding-maintenance", error.message);
  }

  let boundRoot;
  try {
    boundRoot = await sourceRoot(binding);
  } catch (error) {
    return maintenance(descriptor, root, "source-unavailable", error.message);
  }

  let sourceResult;
  if (descriptor.source.kind === "customization") {
    const nested = await checkedCustomizationSource(descriptor.source, boundRoot);
    if (!nested.matches) {
      return maintenance(
        descriptor,
        root,
        "customization-source-mismatch",
        "The bound customization does not match the portable source identity.",
      );
    }
    sourceResult = await visit({
      descriptorPath: nested.descriptorPath,
      context,
      statePath,
      roots,
      managerRecords,
      discoverySnapshot,
      depth: depth + 1,
      activeIds: nextIds,
      activePaths: nextPaths,
      bindings,
      checkedDescriptor: nested.checked,
    });
    if (sourceResult.status === "maintenance-required") return sourceResult;
    if (
      sourceResult.effectiveFingerprint
      !== descriptor.source.effective_fingerprint
    ) {
      return maintenance(
        descriptor,
        root,
        "source-drift",
        "The nested customization effective fingerprint changed.",
      );
    }
  } else {
    const actualSourceFingerprint = await fingerprintPath(boundRoot, {
      excludedPaths: statePathExclusions(statePath),
    });
    if (actualSourceFingerprint !== descriptor.source.effective_fingerprint) {
      return maintenance(
        descriptor,
        root,
        "source-drift",
        "The full source effective fingerprint changed.",
      );
    }
    sourceResult = {
      status: "ready",
      effectiveFingerprint: actualSourceFingerprint,
      steps: [{
        role: "workflow",
        path: path.join(boundRoot, "SKILL.md"),
        root: boundRoot,
        customizationId: null,
      }],
      advisories: [],
    };
  }

  const currentEffective = effectiveFingerprint(
    descriptor,
    ownedFingerprint,
    sourceResult.effectiveFingerprint,
  );
  const advisories = [...sourceResult.advisories];
  return withPublicationToken({
    status: advisories.length > 0 ? "ready-with-advisory" : "ready",
    effectiveFingerprint: currentEffective,
    steps: [
      ...sourceResult.steps,
      {
        role: "delta",
        path: path.join(root, descriptor.customization),
        root,
        customizationId: descriptor.id,
      },
    ],
    advisories,
    maintenanceHandler: null,
  }, {
    // Binding already records the source, provenance, replacement, plugin,
    // and manager evidence it accepted.  Thread only this private token into
    // recovery; public Preflight results keep their established shape.
    paths: publicationPaths(
      root,
      bindingPublicationPaths(binding),
      publicationTokenFor(sourceResult)?.paths ?? [],
    ),
    stateTreePaths: publicationPaths(
      bindingPublicationStateTreePaths(binding),
      publicationTokenFor(sourceResult)?.stateTreePaths ?? [],
    ),
    bindings: [
      { key: bindings.bindingKey(descriptor.id, context), binding },
      ...(publicationTokenFor(sourceResult)?.bindings ?? []),
    ],
  });
}

export async function inspectCustomizationExecution({
  descriptorPath,
  context,
  statePath,
  roots,
  managerRecords = [],
  managerDiagnostics = [],
  discoverySnapshot,
  bindings,
}) {
  if (typeof context !== "string" || !context.trim()) {
    throw new TypeError("preflight context is required");
  }
  const executionBindings = createBindingExecutionAdapter(bindings, {
    statePath,
    roots,
    managerRecords,
    managerDiagnostics,
    discoverySnapshot,
  });
  return visit({
    descriptorPath: path.resolve(descriptorPath),
    context,
    statePath,
    roots,
    managerRecords,
    discoverySnapshot,
    depth: 1,
    activeIds: new Set(),
    activePaths: new Set(),
    bindings: executionBindings,
  });
}
