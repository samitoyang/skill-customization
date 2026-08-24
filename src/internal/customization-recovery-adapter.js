import { BindingError } from "../errors.js";
import { inspectCustomizationExecution } from "../execution-graph.js";

function createReadOnlyBindingOperation(operation, statePath) {
  const readStore = () => operation.readBindingStore(statePath);
  return Object.freeze({
    bindingKey: operation.bindingKey,
    readBindingStore: readStore,
    resolveBinding: async ({ descriptor, context, customizationRoot }) => {
      const store = await readStore();
      const key = operation.bindingKey(descriptor.id, context);
      const binding = store.bindings[key];
      if (!binding) {
        throw new BindingError(`no binding for ${descriptor.id} in ${context}`, {
          code: "BINDING_NOT_FOUND",
        });
      }
      return (
        await operation.validateBinding({ descriptor, binding, customizationRoot })
      ).binding;
    },
    validateBinding: (intent) => operation.validateBinding(intent),
  });
}

/**
 * Wire the recursive execution module into Binding without making Binding
 * depend on graph traversal. The callback exposed to Binding accepts only the
 * candidate descriptor path and request-scoped execution inputs.
 */
export function createCustomizationRecoveryAdapter({
  runtime,
  selectSource,
  createOperation,
  inspectExecution = inspectCustomizationExecution,
} = {}) {
  if (!runtime || typeof runtime !== "object") {
    throw new TypeError("Binding runtime is required");
  }
  if (typeof createOperation !== "function") {
    throw new TypeError("Binding operation factory is required");
  }
  if (typeof inspectExecution !== "function") {
    throw new TypeError("Customization execution inspector is required");
  }
  const recoverCustomizationExecution = ({
    descriptorPath,
    context,
    statePath,
    discoverySnapshot,
    bindings,
  }) => inspectExecution({
    descriptorPath,
    context,
    statePath,
    roots: runtime.roots,
    managerRecords: runtime.managerRecords ?? [],
    discoverySnapshot,
    // Candidate inspection must not create nested bindings before the outer
    // candidate itself has passed the persistence CAS.
    bindings: createReadOnlyBindingOperation(bindings, statePath),
  });
  return createOperation({
    runtime: {
      ...runtime,
      recoverCustomizationExecution,
    },
    selectSource,
  });
}
