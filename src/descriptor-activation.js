import { DESCRIPTOR_INVARIANTS } from "./descriptor-invariants.js";

const ACTIVATION_RELATIONSHIPS = Object.values(
  DESCRIPTOR_INVARIANTS.relationships.activation,
);

/**
 * @param {string} mode
 * @param {unknown} name
 * @param {unknown} sourceName
 * @returns {"coexist" | "replace" | null}
 */
export function getActivationNameConflict(mode, name, sourceName) {
  const relationship = ACTIVATION_RELATIONSHIPS.find(
    ({ mode: relationshipMode }) => relationshipMode === mode,
  );
  if (!relationship) return null;
  if (relationship.nameRule === "different-from-source" && name === sourceName) {
    return relationship.mode;
  }
  if (relationship.nameRule === "same-as-source" && name !== sourceName) {
    return relationship.mode;
  }
  return null;
}
