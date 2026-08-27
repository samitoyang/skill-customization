import path from "node:path";

import { bindingStorePath } from "./bindings.js";
import { ReconciliationError } from "./errors.js";
import { inspectCustomizationExecution } from "./execution-graph.js";
import { createBindingRuntime } from "./internal/binding-runtime.js";
import { validatedBindingTarget } from "./internal/binding-target.js";
import { reconcileCustomization } from "./reconcile.js";

function bindingRuntimeFor(discoveryContext, statePath) {
  if (
    discoveryContext === null
    || typeof discoveryContext !== "object"
    || Array.isArray(discoveryContext)
  ) {
    throw new TypeError("Reconciliation discoveryContext must be an object");
  }
  const managerRecords = discoveryContext.managerRecords ?? [];
  const discoveryOptions = discoveryContext.discoveryOptions ?? {};
  const managerDiagnostics = discoveryContext.managerDiagnostics
    ?? discoveryOptions.managerDiagnostics
    ?? [];
  const context = {
    roots: discoveryContext.roots,
    managerRecords,
    managerDiagnostics,
    statePath,
    discoveryOptions,
    ...(typeof discoveryContext.discover === "function"
      ? { discover: discoveryContext.discover }
      : {}),
  };
  return {
    context,
    operation: createBindingRuntime({
      context,
      discovery: discoveryContext.discovery,
      inspectExecution: inspectCustomizationExecution,
    }),
  };
}

/**
 * Reconcile one Customization from its context-local Binding. Reconciliation
 * owns source resolution and nested Preflight so callers provide intent and
 * operation inputs without transporting Discovery snapshots or execution
 * intermediates.
 */
export async function reconcileBoundCustomization({
  descriptor,
  customizationRoot,
  bindingContext,
  statePath = bindingStorePath(),
  discoveryContext = {},
  ...reconciliation
} = {}) {
  if (descriptor?.type === "fork") {
    return reconcileCustomization({
      ...reconciliation,
      descriptor,
      customizationRoot,
      statePath,
    });
  }
  if (typeof bindingContext !== "string" || !bindingContext.trim()) {
    throw new ReconciliationError(
      "semantic overlay reconciliation requires a Binding context",
      { code: "BINDING_CONTEXT_REQUIRED" },
    );
  }

  const { context, operation } = bindingRuntimeFor(discoveryContext, statePath);
  const binding = await operation.resolveBinding({
    descriptor,
    context: bindingContext,
    customizationRoot,
  });
  // Binding has already checked this request-scoped canonical target. Keep
  // reconciliation on that capability: consulting a persisted alias here
  // would permit a retarget between validation and the nested plan/review.
  const sourcePath = validatedBindingTarget(binding);
  if (typeof sourcePath !== "string") {
    throw new TypeError("Binding did not provide a validated canonical target");
  }
  let sourceEffectiveFingerprint;
  let sourceExecutionPlan;
  if (descriptor.source.kind === "customization") {
    const nested = await inspectCustomizationExecution({
      descriptorPath: path.join(sourcePath, "customization.json"),
      context: bindingContext,
      statePath,
      roots: context.roots,
      managerRecords: context.managerRecords,
      managerDiagnostics: context.managerDiagnostics,
      bindings: operation,
    });
    if (nested.status === "maintenance-required") {
      throw new ReconciliationError(
        `nested customization is not ready: ${nested.maintenanceHandler?.reason ?? "unknown"}`,
        {
          code: "CUSTOMIZATION_SOURCE_NOT_READY",
          details: { maintenanceHandler: nested.maintenanceHandler },
        },
      );
    }
    sourceEffectiveFingerprint = nested.effectiveFingerprint;
    sourceExecutionPlan = nested.steps;
  }

  return reconcileCustomization({
    ...reconciliation,
    descriptor,
    customizationRoot,
    sourcePath,
    sourceEffectiveFingerprint,
    sourceExecutionPlan,
    statePath,
  });
}
