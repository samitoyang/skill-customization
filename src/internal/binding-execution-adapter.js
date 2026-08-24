/**
 * Keep recursive execution dependent on the smallest Binding interface.
 * This module is intentionally outside the package's public exports.
 */
export function createBindingExecutionAdapter(operation) {
  return Object.freeze({
    bindingKey: operation.bindingKey,
    readBindingStore: operation.readBindingStore,
    resolveBinding: operation.resolveBinding,
    validateBinding: operation.validateBinding,
  });
}
