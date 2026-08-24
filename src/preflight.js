import { bindingStorePath } from "./bindings.js";
import {
  inspectCustomizationExecution,
  MAX_CUSTOMIZATION_DEPTH,
} from "./execution-graph.js";
import { createBindingExecutionAdapter } from "./internal/binding-execution-adapter.js";
import { createBindingRuntime } from "./internal/binding-runtime.js";

export { MAX_CUSTOMIZATION_DEPTH };

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  discovery,
  discoveryOptions = {},
}) {
  const operation = createBindingRuntime({
    discovery,
    context: {
      roots,
      managerRecords,
      discoveryOptions,
    },
  });
  return inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
    bindings: createBindingExecutionAdapter(operation),
  });
}
