import {
  bindingKey,
  bindingStorePath,
  readBindingStore,
  resolveBinding,
  validateBinding,
} from "./bindings.js";
import { createDiscoverySnapshot } from "./discovery.js";
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
  discovery,
}) {
  const discoverySnapshot = createDiscoverySnapshot({
    discovery,
    roots,
    managerRecords,
  });
  return inspectCustomizationExecution({
    descriptorPath,
    context,
    statePath,
    roots,
    managerRecords,
    activeSkills,
    discoverySnapshot,
    bindings,
  });
}
