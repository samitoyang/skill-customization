import path from "node:path";

import { createPluginHostAdapter } from "./interface.js";
import { stringValue } from "./metadata.js";

const GEMINI_MANIFEST_POLICY = Object.freeze({
  files: Object.freeze(["gemini-extension.json"]),
  description: "Gemini extension metadata",
});
const GEMINI_INSTALL_METADATA_FILE = ".gemini-extension-install.json";
const GEMINI_REQUIRED_MANIFEST_FIELDS = Object.freeze(["name", "version"]);
const GEMINI_INSTALLATION_TYPES = new Set([
  "git",
  "github-release",
  "local",
  "link",
]);

/** @typedef {import("./interface.js").PluginHostDiscoveryContext} GeminiCliAdapterContext */

function geminiInstallationValidation({ readJsonObject, diagnostic }) {
  return async function validateGeminiInstallation({
    manifest,
    safeInstallRoot,
    initialMetadata,
    context,
  }) {
    let included = manifest.status !== "invalid";
    if (manifest.status === "missing") {
      included = false;
      context.diagnostics.push(
        diagnostic({
          host: "gemini-cli",
          path: safeInstallRoot,
          code: "MISSING_PLUGIN_METADATA",
          message: `missing ${GEMINI_MANIFEST_POLICY.description} in ${safeInstallRoot}`,
          metadata: initialMetadata,
        }),
      );
    } else if (manifest.status === "valid") {
      for (const field of GEMINI_REQUIRED_MANIFEST_FIELDS) {
        if (stringValue(manifest.value[field])) continue;
        included = false;
        context.diagnostics.push(
          diagnostic({
            host: "gemini-cli",
            path: manifest.path,
            code: "INVALID_PLUGIN_METADATA",
            message: `${GEMINI_MANIFEST_POLICY.description} is missing a valid ${field}: ${manifest.path}`,
            metadata: initialMetadata,
          }),
        );
      }
      if (
        stringValue(manifest.value.name)
        && stringValue(manifest.value.name) !== path.basename(safeInstallRoot)
      ) {
        included = false;
        context.diagnostics.push(
          diagnostic({
            host: "gemini-cli",
            path: manifest.path,
            code: "INVALID_PLUGIN_METADATA",
            message: `Gemini extension name must match its extension directory: ${manifest.path}`,
            metadata: initialMetadata,
          }),
        );
      }
    }

    const installationMetadataPath = path.join(
      safeInstallRoot,
      GEMINI_INSTALL_METADATA_FILE,
    );
    let installationMetadata = await readJsonObject(
      installationMetadataPath,
      context,
      {
        host: "gemini-cli",
        metadata: initialMetadata,
        description: "Gemini extension installation metadata",
        boundary: safeInstallRoot,
      },
    );
    if (
      installationMetadata
      && (
        !stringValue(installationMetadata.source)
        || !GEMINI_INSTALLATION_TYPES.has(installationMetadata.type)
      )
    ) {
      context.diagnostics.push(
        diagnostic({
          host: "gemini-cli",
          path: installationMetadataPath,
          code: "INVALID_PLUGIN_INSTALL_METADATA",
          message: `invalid Gemini extension installation metadata: ${installationMetadataPath}`,
          metadata: initialMetadata,
        }),
      );
      installationMetadata = undefined;
    }
    return {
      include: included,
      ...(installationMetadata ? { installationMetadata } : {}),
    };
  };
}

/**
 * Create the Gemini CLI host adapter from shared plugin observation primitives.
 * The adapter owns Gemini locations, installation interpretation, activation
 * policy, fallbacks, and diagnostics; injected functions emit host-independent
 * records.
 *
 * @param {import("./interface.js").GeminiCliAdapterToolkit} toolkit
 * @returns {import("./interface.js").PluginHostAdapter}
 */
export function createGeminiCliAdapter({
  addPluginInstall,
  diagnostic,
  pluginDirectories,
  readJsonObject,
  safeDirectory,
}) {
  const validateGeminiInstallation = geminiInstallationValidation({
    diagnostic,
    readJsonObject,
  });

  async function discoverGeminiExtensions({
    root,
    boundary,
    scope,
    context,
  }) {
    const safeRoot = await safeDirectory(
      root,
      boundary,
      context,
      { host: "gemini-cli", source: "extension" },
    );
    if (!safeRoot) return;
    for (const extension of await pluginDirectories(
      safeRoot,
      context,
      { host: "gemini-cli", source: "extension" },
    )) {
      await addPluginInstall({
        installRoot: extension.path,
        boundary: safeRoot,
        host: "gemini-cli",
        marketplace: "local",
        name: extension.entry.name,
        scope,
        source: {},
        active: true,
        context,
        manifestPolicy: GEMINI_MANIFEST_POLICY,
        manifestValidation: validateGeminiInstallation,
      });
    }
  }

  async function discoverGemini(context) {
    context.host = "gemini-cli";
    const geminiCliHome = path.resolve(
      stringValue(context.env.GEMINI_CLI_HOME) ?? context.home,
    );
    const geminiHome = path.join(geminiCliHome, ".gemini");
    await discoverGeminiExtensions({
      root: path.join(geminiHome, "extensions"),
      boundary: geminiHome,
      scope: "global",
      context,
    });
    for (const workspace of context.workspaceDirectories) {
      await discoverGeminiExtensions({
        root: path.join(workspace, ".gemini", "extensions"),
        boundary: workspace,
        scope: "workspace",
        context,
      });
    }
  }

  return createPluginHostAdapter("gemini-cli", discoverGemini);
}
