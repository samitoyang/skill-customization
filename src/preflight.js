import {
  bindingStorePath,
  createBindingOperation,
} from "./bindings.js";
import {
  inspectCustomizationExecution,
  MAX_CUSTOMIZATION_DEPTH,
} from "./execution-graph.js";

export { MAX_CUSTOMIZATION_DEPTH };

function executionBindingAdapter(operation) {
  return Object.freeze({
    bindingKey: operation.bindingKey,
    readBindingStore: operation.readBindingStore,
    resolveBinding: operation.resolveBinding,
    validateBinding: operation.validateBinding,
  });
}

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  discovery,
  discoveryOptions = {},
}) {
  const operation = createBindingOperation({
    discovery,
    roots,
    managerRecords,
    discoveryOptions,
  });
  return inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
    bindings: executionBindingAdapter(operation),
  });
}
