/**
 * Keep recursive execution dependent on the smallest Binding interface.
 * This module is intentionally outside the package's public exports.
 *
 * Binding owns its request lifecycle. This adapter exposes only the subset of
 * caller intent recursive execution needs.
 */
export function createBindingExecutionAdapter(operation) {
  return Object.freeze({
    bindingKey: operation.bindingKey,
    readBindingStore: operation.readBindingStore,
    resolveBinding: (intent) => operation.resolveBinding(intent),
    validateBinding: (intent) => operation.validateBinding(intent),
  });
}
