import { DESCRIPTOR_INVARIANTS } from "./descriptor-invariants.js";

const RUNTIME_PATH_EXCLUSION = new RegExp(
  DESCRIPTOR_INVARIANTS.patterns.runtimePathExclusion.source,
);
const VERSION_CONTROL_METADATA = new Set([".git", ".hg", ".svn"]);
const EMBEDDED_SOURCE_METADATA = ".skill-source.json";

export function isVersionControlMetadataPath(relativePath) {
  return relativePath
    .split("/")
    .some((segment) => VERSION_CONTROL_METADATA.has(segment.toLowerCase()));
}

export function isSourceFingerprintExcludedPath(relativePath) {
  const segments = relativePath.split("/");
  return isVersionControlMetadataPath(relativePath)
    || (
      segments.length === 1
      && segments[0].toLowerCase() === EMBEDDED_SOURCE_METADATA
    );
}

export function isOwnedPayloadExcludedPath(relativePath) {
  return typeof relativePath === "string" && RUNTIME_PATH_EXCLUSION.test(relativePath);
}
