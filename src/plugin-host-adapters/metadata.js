export const GENERIC_MANIFEST_FILES = Object.freeze([
  "plugin.json",
  "manifest.json",
  "package.json",
]);

export const GENERIC_MARKETPLACE_MANIFEST_FILES = Object.freeze([
  "marketplace.json",
  "plugins.json",
  "manifest.json",
]);

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function safeIdentityPart(value, fallback = "local") {
  return (stringValue(value) ?? fallback)
    .replaceAll("%", "%25")
    .replaceAll("/", "%2F")
    .replaceAll("\\", "%5C")
    .replaceAll(":", "%3A");
}
