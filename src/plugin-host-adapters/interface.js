/**
 * @typedef {object} PluginHostRootObservation
 * @property {string} path
 * @property {string} owner
 * @property {string} scope
 * @property {string} origin
 * @property {"plugin"} [kind]
 * @property {readonly string[]} [owners]
 * @property {string} [host]
 * @property {Record<string, unknown>} [plugin]
 * @property {Record<string, unknown>} [pluginMetadata]
 * @property {string} [pluginManifest]
 * @property {string} [pluginRoot]
 * @property {string} [pluginIdentity]
 * @property {readonly string[]} [pluginIdentities]
 * @property {readonly Record<string, unknown>[]} [pluginEvidence]
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
 * @property {Map<string, Set<string>>} marketplaceOwnedRootsByHost
 * @property {PluginHostRootObservation[]} roots
 * @property {PluginHostDiagnostic[]} diagnostics
 * @property {string} [host]
 * @property {string} [claudeHome]
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
 * @typedef {object} PluginHostAdapterToolkit
 * @property {(options: Record<string, unknown>) => Promise<boolean>} addPluginInstall
 * @property {(options: Record<string, unknown>) => PluginHostDiagnostic} diagnostic
 * @property {(options: Record<string, unknown>) => Promise<boolean>} discoverMarketplaceManifests
 * @property {(options: Record<string, unknown>) => Promise<void>} discoverVersionedPluginCache
 * @property {(root: string, context: PluginHostDiscoveryContext, metadata: Record<string, unknown>, filter?: (entry: {name: string}) => boolean) => Promise<readonly PluginHostDirectoryEntry[]>} pluginDirectories
 * @property {(target: string, boundary: string, context: PluginHostDiscoveryContext, metadata: Record<string, unknown>, options?: {declared?: boolean}) => Promise<string | undefined>} safeDirectory
 * @property {(target: string, encoding: "utf8") => Promise<string>} readFile
 */

/**
 * @typedef {PluginHostAdapterToolkit & {
 *   canonicalContained: (candidate: string, boundary: string) => Promise<boolean>,
 *   metadataFor: (metadata: Record<string, unknown>) => Record<string, unknown>,
 *   pluginEvidence: (options: Record<string, unknown>) => {evidence: Record<string, unknown>},
 *   pluginIdentity: (metadata: Record<string, unknown>) => string,
 *   readJsonObject: (file: string, context: PluginHostDiscoveryContext, options: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
 *   realpath: (target: string) => Promise<string>,
 *   stat: (target: string) => Promise<{isDirectory: () => boolean}>,
 * }} ClaudeCodeAdapterToolkit
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
  return Object.freeze({
    roots: Object.freeze([...context.roots]),
    diagnostics: Object.freeze([...context.diagnostics]),
  });
}
