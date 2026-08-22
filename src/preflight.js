import {
  bindingKey,
  bindingStorePath,
  readBindingStore,
  resolveBinding,
  validateBinding,
} from "./bindings.js";
import {
  inspectCustomizationExecution,
  MAX_CUSTOMIZATION_DEPTH,
} from "./execution-graph.js";

export { MAX_CUSTOMIZATION_DEPTH };

const bindings = Object.freeze({
  bindingKey,
  readBindingStore,
  resolveBinding,
  validateBinding,
});

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  activeSkills,
}) {
  return inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
    activeSkills,
    bindings,
  });
}
