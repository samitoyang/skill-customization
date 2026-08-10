const EXCLUDED_ROOTS = new Set(["customization.json", "provenance"]);

export function isOwnedPayloadExcludedPath(relativePath) {
  return EXCLUDED_ROOTS.has(relativePath.split("/", 1)[0].toLowerCase());
}
