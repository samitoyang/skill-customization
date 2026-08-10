import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  bindingKey,
  bindingStorePath,
  readBindingStore,
  resolveBinding,
} from "./bindings.js";
import { readDescriptor } from "./descriptor.js";
import {
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "./fingerprint.js";
import { reconcileCustomization } from "./reconcile.js";

export const MAX_CUSTOMIZATION_DEPTH = 32;

function handlerFor(descriptor, root, reason, detail) {
  const skill = descriptor.type === "fork" ? "skill-fork" : "skill-overlay";
  return {
    skill,
    customizationId: descriptor.id,
    path: root,
    reason,
    action: `Delegate to ${skill}, accept or repair the maintenance decision, then rerun preflight.`,
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

async function sourceRoot(binding) {
  const lookup = binding.source.alias ?? binding.source.path;
  const target = await realpath(lookup);
  const info = await lstat(target);
  return info.isDirectory() ? target : path.dirname(target);
}

async function forkTrackingAdvisory(descriptor, {
  context,
  statePath,
  roots,
  managerRecords,
  activeSkills,
  depth,
  activeIds,
  activePaths,
}) {
  let store;
  try {
    store = await readBindingStore(statePath);
  } catch (error) {
    return {
      code: "tracking-state-invalid",
      message: "The optional fork tracking state is unreadable or invalid; fork execution is unaffected.",
      detail: error.message,
    };
  }
  const binding = store.bindings[bindingKey(descriptor.id, context)];
  if (!binding) return undefined;
  const lookup = binding.source?.alias ?? binding.source?.path;
  if (!lookup) {
    return {
      code: "tracking-binding-invalid",
      message: "The optional fork tracking binding is incomplete; fork execution is unaffected.",
    };
  }
  try {
    const target = await realpath(lookup);
    const info = await lstat(target);
    const root = info.isDirectory() ? target : path.dirname(target);
    const expected = descriptor.source.effective_fingerprint;
    let current;
    if (descriptor.source.kind === "customization") {
      const nestedDescriptorPath = path.join(root, "customization.json");
      const nestedDescriptor = await readDescriptor(nestedDescriptorPath);
      if (!matchesCustomizationSource(descriptor.source, nestedDescriptor)) {
        return {
          code: "tracking-binding-invalid",
          message: "The optional fork tracking binding does not match the reviewed customization identity; fork execution is unaffected.",
        };
      }
      const tracked = await visit({
        descriptorPath: nestedDescriptorPath,
        context,
        statePath,
        roots,
        managerRecords,
        activeSkills,
        depth: depth + 1,
        activeIds,
        activePaths,
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
      current = await fingerprintPath(root);
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

function matchesCustomizationSource(source, descriptor) {
  return source.kind === "customization"
    && source.id === descriptor.id
    && source.type === descriptor.type
    && source.skill_name === descriptor.name
    && source.license === descriptor.license;
}

async function visit({
  descriptorPath,
  context,
  statePath,
  roots,
  managerRecords,
  activeSkills,
  depth,
  activeIds,
  activePaths,
}) {
  const descriptor = await readDescriptor(descriptorPath);
  const root = await realpath(path.dirname(path.resolve(descriptorPath)));
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
      await reconcileCustomization({ descriptor, customizationRoot: root });
    } catch (error) {
      return maintenance(descriptor, root, "fork-payload-or-provenance-drift", error.message);
    }
    const advisory = await forkTrackingAdvisory(descriptor, {
      context,
      statePath,
      roots,
      managerRecords,
      activeSkills,
      depth,
      activeIds: nextIds,
      activePaths: nextPaths,
    });
    const advisories = advisory ? [advisory] : [];
    return {
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
    };
  }

  let binding;
  try {
    binding = await resolveBinding({
      descriptor,
      context,
      statePath,
      roots,
      managerRecords,
      activeSkills,
    });
  } catch (error) {
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
    const nestedDescriptorPath = path.join(boundRoot, "customization.json");
    let nestedDescriptor;
    try {
      nestedDescriptor = await readDescriptor(nestedDescriptorPath);
    } catch (error) {
      throw error;
    }
    if (!matchesCustomizationSource(descriptor.source, nestedDescriptor)) {
      return maintenance(
        descriptor,
        root,
        "customization-source-mismatch",
        "The bound customization does not match the portable source identity.",
      );
    }
    sourceResult = await visit({
      descriptorPath: nestedDescriptorPath,
      context,
      statePath,
      roots,
      managerRecords,
      activeSkills,
      depth: depth + 1,
      activeIds: nextIds,
      activePaths: nextPaths,
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
    const actualSourceFingerprint = await fingerprintPath(boundRoot);
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
  return {
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
  };
}

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots = [],
  managerRecords = [],
  activeSkills,
}) {
  if (typeof context !== "string" || !context.trim()) {
    throw new TypeError("preflight context is required");
  }
  return visit({
    descriptorPath: path.resolve(descriptorPath),
    context,
    statePath,
    roots,
    managerRecords,
    activeSkills,
    depth: 1,
    activeIds: new Set(),
    activePaths: new Set(),
  });
}
