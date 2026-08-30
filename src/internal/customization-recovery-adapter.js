import { BindingError } from "../errors.js";

function createReadOnlyBindingOperation(operation, { graphReadOnly = false } = {}) {
  const readStore = operation.readBindingStore;
  const validate = (intent) => {
    if (!graphReadOnly) return operation.validateBinding(intent);
    if (typeof operation.validateBindingReadOnly !== "function") {
      throw new TypeError("read-only Binding validation is required for graph rechecks");
    }
    return operation.validateBindingReadOnly(intent);
  };
  return Object.freeze({
    bindingKey: operation.bindingKey,
    resolveTrackingBinding: (intent) => operation.resolveTrackingBinding(intent),
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
        await validate({ descriptor, binding, customizationRoot })
      ).binding;
    },
    validateBinding: (intent) => validate(intent),
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
  inspectExecution,
} = {}) {
  if (!runtime || typeof runtime !== "object") {
    throw new TypeError("Binding runtime is required");
  }
  if (typeof createOperation !== "function") {
    throw new TypeError("Binding operation factory is required");
  }
  const recoverCustomizationExecution = typeof inspectExecution === "function"
    ? ({
        descriptorPath,
        context,
        statePath,
        discoverySnapshot,
        bindings,
        readOnly = false,
      }) => inspectExecution({
        descriptorPath,
        context,
        statePath,
        roots: runtime.roots,
        managerRecords: runtime.managerRecords ?? [],
        managerDiagnostics: runtime.managerDiagnostics ?? [],
        discoverySnapshot,
        // Candidate inspection must not create nested bindings before the outer
        // candidate itself has passed the persistence CAS.
        bindings: createReadOnlyBindingOperation(bindings, {
          graphReadOnly: readOnly,
        }),
      })
    : undefined;
  return createOperation({
    runtime: {
      ...runtime,
      ...(recoverCustomizationExecution ? { recoverCustomizationExecution } : {}),
    },
    selectSource,
  });
}
