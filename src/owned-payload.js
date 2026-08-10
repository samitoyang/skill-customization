const EXCLUDED_ROOTS = new Set(["customization.json", "provenance"]);
const VERSION_CONTROL_METADATA = new Set([".git", ".hg", ".svn"]);

export function isVersionControlMetadataPath(relativePath) {
  return relativePath
    .split("/")
    .some((segment) => VERSION_CONTROL_METADATA.has(segment.toLowerCase()));
}

export function isOwnedPayloadExcludedPath(relativePath) {
  return EXCLUDED_ROOTS.has(relativePath.split("/", 1)[0].toLowerCase())
    || isVersionControlMetadataPath(relativePath);
}
