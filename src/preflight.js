import {
  bindingStorePath,
  createBindingOperation,
} from "./bindings.js";
import { MAX_CUSTOMIZATION_DEPTH } from "./execution-graph.js";

export { MAX_CUSTOMIZATION_DEPTH };

export async function preflightCustomization({
  descriptorPath,
  context,
  statePath = bindingStorePath(),
  roots,
  managerRecords = [],
  discovery,
}) {
  const bindings = createBindingOperation({
    discovery,
    roots,
    managerRecords,
  });
  return bindings.inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
  });
}
