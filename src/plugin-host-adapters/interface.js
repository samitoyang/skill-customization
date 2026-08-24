/** @typedef {import("../provenance.js").PluginProvenanceObservation} PluginProvenanceObservation */
/** @typedef {PluginProvenanceObservation & {synced?: boolean}} PluginHostProvenanceObservation */

/**
 * @typedef {object} PluginHostRootObservation
 * @property {string} path
 * @property {string} owner
 * @property {string} scope
 * @property {"plugin"} origin
 * @property {"plugin"} kind
 * @property {readonly string[]} [aliases]
 * @property {readonly string[]} [owners]
 * @property {string} host
 * @property {Record<string, unknown>} [plugin]
 * @property {Record<string, unknown>} [pluginMetadata]
 * @property {string} [pluginManifest]
 * @property {string} [pluginRoot]
 * @property {readonly string[]} [pluginRoots]
 * @property {string} [pluginIdentity]
 * @property {readonly string[]} [pluginIdentities]
 * @property {readonly PluginHostProvenanceObservation[]} [pluginEvidence]
 * @property {boolean} [active]
 * @property {boolean} [singleSkill]
 * @property {boolean} [includeRootSkill]
 */

/**
 * @typedef {object} PluginHostDiagnostic
 * @property {"plugin"} kind
 * @property {string} host
 * @property {string} path
 * @property {string} code
 * @property {string} message
 * @property {Record<string, unknown>} [plugin]
 */

/**
 * @typedef {object} PluginHostDiscoveryContext
 * @property {string} home
 * @property {string} cwd
 * @property {Record<string, string | undefined>} env
 * @property {readonly string[]} workspaceDirectories
 * @property {PluginHostRootObservation[]} roots
 * @property {PluginHostDiagnostic[]} diagnostics
 * @property {string} [host]
 */

/**
 * @typedef {object} PluginHostDiscoveryResult
 * @property {readonly PluginHostRootObservation[]} roots
 * @property {readonly PluginHostDiagnostic[]} diagnostics
 */

/**
 * @typedef {object} PluginHostDirectoryEntry
 * @property {string} path
 * @property {{name: string}} entry
 */

/**
 * @typedef {object} PluginHostDiagnosticInput
 * @property {string} host
 * @property {string} path
 * @property {string} code
 * @property {string} message
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {object} PluginHostInstallOptions
 * @property {string} installRoot
 * @property {string} boundary
 * @property {string} host
 * @property {string} marketplace
 * @property {string} name
 * @property {string} scope
 * @property {Record<string, unknown>} source
 * @property {PluginHostDiscoveryContext} context
 * @property {string} [version]
 * @property {Record<string, unknown>} [cache]
 * @property {boolean} [active]
 * @property {Record<string, unknown>} [declaration]
 * @property {string} [defaultSkillDirectory]
 * @property {boolean} [includeDefaultSkillDirectory]
 * @property {Record<string, unknown>} [manifestPolicy]
 * @property {(options: {manifest: {status: "missing"|"invalid"|"valid", value?: Record<string, unknown>, path?: string}, safeInstallRoot: string, initialMetadata: PluginHostMetadata, context: PluginHostDiscoveryContext}) => Promise<PluginHostManifestValidationResult>} [manifestValidation]
 * @property {(metadata: Record<string, unknown>) => string} [localPluginIdentity]
 */

/**
 * @typedef {object} PluginHostMarketplaceOptions
 * @property {string} base
 * @property {string} boundary
 * @property {PluginHostDiscoveryContext} context
 * @property {string} host
 * @property {string} scope
 * @property {string} [marketplaceName]
 * @property {boolean} [active]
 * @property {Record<string, unknown>} [manifestPolicy]
 * @property {PluginHostMarketplacePolicy} [marketplacePolicy]
 * @property {(options: {location: {installRoot: string, boundary: string}, entry: Record<string, unknown>, file: string, context: PluginHostDiscoveryContext}) => (boolean | Promise<boolean>)} [onDeclaredPlugin]
 * @property {readonly string[]} [manifestFiles]
 * @property {readonly string[]} [marketplaceRootDirectories]
 * @property {(metadata: Record<string, unknown>) => string} [localPluginIdentity]
 */

/**
 * @typedef {object} PluginHostCacheOptions
 * @property {string} cacheRoot
 * @property {string} boundary
 * @property {PluginHostDiscoveryContext} context
 * @property {string} host
 * @property {string} scope
 * @property {boolean} [active]
 * @property {Record<string, unknown>} [manifestPolicy]
 * @property {(metadata: Record<string, unknown>) => string} [localPluginIdentity]
 */

/** @typedef {Record<string, unknown>} PluginHostMetadata */

/**
 * @typedef {object} PluginHostMarketplacePolicyContext
 * @property {Record<string, unknown>} manifest
 * @property {string} file
 * @property {string} safeBase
 * @property {string} sourceBase
 * @property {PluginHostDiscoveryContext} context
 * @property {string} host
 * @property {string} marketplace
 */

/**
 * @typedef {object} PluginHostMarketplacePolicyResult
 * @property {boolean} valid
 * @property {readonly Record<string, unknown>[]} entries
 * @property {string} [pluginRoot]
 */

/**
 * @typedef {object} PluginHostMarketplacePolicy
 * @property {(context: PluginHostMarketplacePolicyContext) => (PluginHostMarketplacePolicyResult | Promise<PluginHostMarketplacePolicyResult>)} validate
 * @property {(entry: {entry: Record<string, unknown>, file: string, context: PluginHostDiscoveryContext, marketplace: string}) => (boolean | Promise<boolean>)} [validateEntry]
 */

/**
 * @typedef {object} PluginHostManifestValidationResult
 * @property {boolean} include Whether the installation should be included.
 * @property {Record<string, unknown>} [installationMetadata]
 */

/**
 * @typedef {object} PluginHostAdapterToolkit
 * @property {(options: PluginHostInstallOptions) => Promise<boolean>} addPluginInstall
 * @property {(options: PluginHostDiagnosticInput) => PluginHostDiagnostic} diagnostic
 * @property {(options: PluginHostMarketplaceOptions) => Promise<boolean>} discoverMarketplaceManifests
 * @property {(root: string, context: PluginHostDiscoveryContext, metadata: PluginHostMetadata, filter?: (entry: {name: string}) => boolean) => Promise<readonly PluginHostDirectoryEntry[]>} pluginDirectories
 * @property {(target: string, boundary: string, context: PluginHostDiscoveryContext, metadata: PluginHostMetadata, options?: {declared?: boolean}) => Promise<string | undefined>} safeDirectory
 */

/**
 * @typedef {PluginHostAdapterToolkit & {
 *   discoverVersionedPluginCache: (options: PluginHostCacheOptions) => Promise<void>,
 * }} PluginHostCacheToolkit
 */

/**
 * @typedef {PluginHostCacheToolkit & {
 *   canonicalContained: (candidate: string, boundary: string) => Promise<boolean>,
 *   metadataFor: (metadata: PluginHostMetadata) => PluginHostMetadata,
 *   pluginEvidence: (options: {metadata: PluginHostMetadata, source: Record<string, unknown>}) => {evidence: Record<string, unknown>},
 *   pluginIdentity: (metadata: PluginHostMetadata) => string,
 *   readJsonObject: (file: string, context: PluginHostDiscoveryContext, options: PluginHostMetadata) => Promise<Record<string, unknown> | undefined>,
 *   realpath: (target: string) => Promise<string>,
 *   stat: (target: string) => Promise<{isDirectory: () => boolean}>,
 * }} ClaudeCodeAdapterToolkit
 */

/**
 * @typedef {PluginHostCacheToolkit & {
 *   readFile: (target: string, encoding: "utf8") => Promise<string>,
 * }} CodexAdapterToolkit
 */

/**
 * @typedef {object} GeminiCliAdapterToolkit
 * @property {(options: PluginHostInstallOptions) => Promise<boolean>} addPluginInstall
 * @property {(options: PluginHostDiagnosticInput) => PluginHostDiagnostic} diagnostic
 * @property {(root: string, context: PluginHostDiscoveryContext, metadata: PluginHostMetadata, filter?: (entry: {name: string}) => boolean) => Promise<readonly PluginHostDirectoryEntry[]>} pluginDirectories
 * @property {(file: string, context: PluginHostDiscoveryContext, options?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>} readJsonObject
 * @property {(target: string, boundary: string, context: PluginHostDiscoveryContext, metadata: PluginHostMetadata, options?: {declared?: boolean}) => Promise<string | undefined>} safeDirectory
 */

/**
 * @typedef {PluginHostAdapterToolkit & {
 *   canonicalContained: (candidate: string, boundary: string) => Promise<boolean>,
 *   lstat: (target: string) => Promise<{isFile: () => boolean, isDirectory?: () => boolean, isSymbolicLink?: () => boolean}>,
 *   pluginIdentity: (metadata: PluginHostMetadata) => string,
 *   realpath: (target: string) => Promise<string>,
 * }} CursorAdapterToolkit
 */

/**
 * @typedef {object} PluginHostAdapter
 * @property {string} host
 * @property {(context: PluginHostDiscoveryContext) => Promise<PluginHostDiscoveryResult>} discover
 */

/**
 * Convert the mutable observation sink used by shared filesystem primitives
 * into the immutable result returned by a host adapter.
 *
 * @param {PluginHostDiscoveryContext} context
 * @returns {PluginHostDiscoveryResult}
 */
export function pluginHostResult(context) {
  const roots = context.roots.map((root) => immutablePluginHostRecord(root));
  const diagnostics = context.diagnostics.map((entry) => immutablePluginHostRecord(entry));
  return Object.freeze({
    roots: Object.freeze(roots),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Clone and freeze one adapter-owned record without freezing the mutable
 * discovery context that produced it.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function immutablePluginHostRecord(value) {
  return freezeDeep(structuredClone(value));
}

/**
 * @param {unknown} value
 * @returns {value is PluginHostDiscoveryResult}
 */
export function isPluginHostResult(value) {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray(value.roots)
    && Array.isArray(value.diagnostics),
  );
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}
