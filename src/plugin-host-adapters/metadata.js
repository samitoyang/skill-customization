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
