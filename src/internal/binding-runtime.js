import { bindingStorePath, createBindingOperation } from "../bindings.js";
import { createCustomizationRecoveryAdapter } from "./customization-recovery-adapter.js";

/**
 * Construct the opaque request-scoped Binding runtime used by CLI and
 * Preflight. Discovery lifecycle data stays in this private composition root;
 * the returned operation accepts only Binding intent and interaction policy.
 */
export function createBindingRuntime({
  context = {},
  discovery,
  discoverySnapshot,
  selectSource,
  inspectExecution,
} = {}) {
  const runtime = Object.freeze({
    discovery,
    discoverySnapshot,
    roots: context.roots,
    managerRecords: context.managerRecords ?? [],
    managerDiagnostics: context.managerDiagnostics,
    statePath: context.statePath ?? bindingStorePath(),
    discoveryOptions: context.discoveryOptions ?? {},
    ...(context.discover ? { discover: context.discover } : {}),
    ...(typeof context.refreshDiscovery === "function"
      ? { refreshDiscovery: context.refreshDiscovery }
      : {}),
  });
  return createCustomizationRecoveryAdapter({
    runtime,
    selectSource,
    createOperation: createBindingOperation,
    inspectExecution,
  });
}
