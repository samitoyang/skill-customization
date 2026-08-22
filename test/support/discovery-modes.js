import { discoverSkills } from "../../src/discovery.js";

function requireExplicitArray(options, name, mode) {
  if (!Object.hasOwn(options, name) || !Array.isArray(options[name])) {
    throw new TypeError(`${name} must be an explicit array in ${mode} discovery`);
  }
}

/**
 * Deterministic discovery seam for ordinary tests.
 *
 * Callers must declare every filesystem and manager input. Plugin discovery is
 * disabled even when a caller accidentally supplies an ambient plugin adapter.
 */
export async function discoverFixtureSkills(options = {}) {
  requireExplicitArray(options, "roots", "fixture");
  requireExplicitArray(options, "managerRecords", "fixture");
  return discoverSkills({
    ...options,
    includePlugins: false,
  });
}

/**
 * Explicit integration seam for tests of host and plugin discovery.
 *
 * The complete ambient context is required so a test cannot silently inherit
 * the developer's process defaults. Manager input remains separately declared.
 */
export async function discoverAmbientSkills(options = {}) {
  if (
    typeof options.home !== "string"
    || !options.home
    || typeof options.cwd !== "string"
    || !options.cwd
    || options.env === null
    || typeof options.env !== "object"
    || Array.isArray(options.env)
  ) {
    throw new TypeError("home, cwd, and env must be explicit in ambient discovery");
  }
  requireExplicitArray(options, "managerRecords", "ambient");
  if (["roots", "additionalRoots", "customPath"].some((name) =>
    Object.hasOwn(options, name),
  )) {
    throw new TypeError("ambient discovery does not accept explicit roots");
  }
  if (options.includePlugins === false) {
    throw new TypeError("ambient discovery cannot disable plugin discovery");
  }
  return discoverSkills({
    ...options,
    includePlugins: true,
  });
}
