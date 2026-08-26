// A Binding validation authorizes one canonical target for the rest of this
// request. Keep that ephemeral capability separate from persisted bindings so
// callers cannot accidentally serialize or later re-resolve an alias.
const validatedTargets = new WeakMap();

export function attachValidatedBindingTarget(binding, target) {
  validatedTargets.set(binding, target);
  return binding;
}

export function validatedBindingTarget(binding) {
  return validatedTargets.get(binding);
}
