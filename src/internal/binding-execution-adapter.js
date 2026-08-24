/**
 * Keep recursive execution dependent on the smallest Binding interface.
 * This module is intentionally outside the package's public exports.
 *
 * The graph owns traversal state, while this adapter owns the fixed Binding
 * lifecycle inputs for one execution request. Graph callers therefore pass
 * only Binding intent, not Discovery or manager plumbing.
 */
export function createBindingExecutionAdapter(
  operation,
  {
    statePath,
    roots,
    managerRecords = [],
    discoverySnapshot,
  } = {},
) {
  const withLifecycle = (intent = {}) => ({
    ...intent,
    statePath,
    roots,
    managerRecords,
    discoverySnapshot,
  });

  return Object.freeze({
    bindingKey: operation.bindingKey,
    readBindingStore: () => operation.readBindingStore(statePath),
    resolveBinding: (intent) => operation.resolveBinding(withLifecycle(intent)),
    validateBinding: (intent) => operation.validateBinding(withLifecycle(intent)),
  });
}
