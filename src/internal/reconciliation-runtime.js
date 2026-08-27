import path from "node:path";

import { bindingStorePath } from "../bindings.js";
import { ReconciliationError } from "../errors.js";
import { inspectCustomizationExecution } from "../execution-graph.js";
import { reconcileCustomization } from "../reconcile.js";
import { createBindingRuntime } from "./binding-runtime.js";
import { validatedBindingTarget } from "./binding-target.js";

function bindingRuntimeFor(discoveryContext, statePath, inspectExecution) {
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
  };
  return {
    context,
    operation: createBindingRuntime({ context, inspectExecution }),
  };
}

function nestedNotReady(nested) {
  throw new ReconciliationError(
    `nested customization is not ready: ${nested.maintenanceHandler?.reason ?? "unknown"}`,
    {
      code: "CUSTOMIZATION_SOURCE_NOT_READY",
      details: { maintenanceHandler: nested.maintenanceHandler },
    },
  );
}

async function checkedNestedExecution({
  sourcePath,
  bindingContext,
  statePath,
  context,
  operation,
  inspectExecution,
}) {
  const nested = await inspectExecution({
    descriptorPath: path.join(sourcePath, "customization.json"),
    context: bindingContext,
    statePath,
    roots: context.roots,
    managerRecords: context.managerRecords,
    managerDiagnostics: context.managerDiagnostics,
    bindings: operation,
  });
  if (nested.status === "maintenance-required") nestedNotReady(nested);
  return nested;
}

/**
 * Reconcile one Customization from its context-local Binding. Reconciliation
 * owns source resolution and nested Preflight so callers provide intent and
 * Discovery configuration without transporting source paths, snapshots, or
 * checked execution intermediates.
 */
export async function reconcileBoundCustomization({
  ...options
} = {}) {
  return reconcileBoundCustomizationWithRuntime(options);
}

// Private composition/test seam. The public operation always supplies the
// production graph inspector; adapters and snapshots never cross its API.
export async function reconcileBoundCustomizationWithRuntime({
  descriptor,
  customizationRoot,
  bindingContext,
  statePath = bindingStorePath(),
  discoveryContext = {},
  cachePath,
  semanticReconciler,
} = {}, {
  inspectExecution = inspectCustomizationExecution,
} = {}) {
  if (descriptor?.type === "fork") {
    return reconcileCustomization({
      descriptor,
      customizationRoot,
      statePath,
      cachePath,
      semanticReconciler,
    });
  }
  if (typeof bindingContext !== "string" || !bindingContext.trim()) {
    throw new ReconciliationError(
      "semantic overlay reconciliation requires a Binding context",
      { code: "BINDING_CONTEXT_REQUIRED" },
    );
  }

  const { context, operation } = bindingRuntimeFor(
    discoveryContext,
    statePath,
    inspectExecution,
  );
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
  const nested = descriptor.source.kind === "customization"
    ? await checkedNestedExecution({
        sourcePath,
        bindingContext,
        statePath,
        context,
        operation,
        inspectExecution,
      })
    : undefined;

  return reconcileCustomization({
    descriptor,
    customizationRoot,
    sourcePath,
    sourceEffectiveFingerprint: nested?.effectiveFingerprint,
    sourceExecutionPlan: nested?.steps,
    statePath,
    cachePath,
    semanticReconciler,
    verifySource: nested
      ? async () => {
          const current = await checkedNestedExecution({
            sourcePath,
            bindingContext,
            statePath,
            context,
            operation,
            inspectExecution,
          });
          if (current.effectiveFingerprint !== nested.effectiveFingerprint) {
            throw new ReconciliationError(
              "nested customization changed during reconciliation",
              {
                code: "CUSTOMIZATION_SOURCE_CHANGED_DURING_RECONCILIATION",
                details: {
                  expectedFingerprint: nested.effectiveFingerprint,
                  actualFingerprint: current.effectiveFingerprint,
                },
              },
            );
          }
        }
      : undefined,
  });
}
