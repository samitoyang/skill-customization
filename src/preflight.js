import { bindingStorePath } from "./bindings.js";
import {
  inspectCustomizationExecution,
  MAX_CUSTOMIZATION_DEPTH,
} from "./execution-graph.js";
import { createBindingRuntime } from "./internal/binding-runtime.js";

export { MAX_CUSTOMIZATION_DEPTH };

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  managerDiagnostics: suppliedManagerDiagnostics,
  discovery,
  discoveryOptions = {},
}) {
  const managerDiagnostics = suppliedManagerDiagnostics
    ?? discoveryOptions.managerDiagnostics
    ?? [];
  const operation = createBindingRuntime({
    discovery,
    context: {
      roots,
      managerRecords,
      managerDiagnostics,
      discoveryOptions,
    },
    inspectExecution: inspectCustomizationExecution,
  });
  return inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
    managerDiagnostics,
    bindings: operation,
  });
}
