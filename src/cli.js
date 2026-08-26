import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import { bindingStorePath } from "./bindings.js";
import { createBindingRuntime } from "./internal/binding-runtime.js";
import {
  helperContractSupport,
  isValidHelperContract,
} from "./contracts.js";
import { readDescriptor } from "./descriptor.js";
import {
  confirmDiscoverySelection,
  configuredHostSkillRoots,
  discoverSkills,
} from "./discovery.js";
import { renderDispatcher } from "./dispatcher-renderer.js";
import { DiscoveryError } from "./errors.js";
import { fingerprintPath, payloadFingerprint } from "./fingerprint.js";
import { collectManagerRecords } from "./manager-collector.js";
import { reconcileBoundCustomization } from "./reconciliation-operation.js";
import { preflightCustomization } from "./preflight.js";
import { acceptMaintenanceUpdate } from "./maintenance.js";
import { inspectCustomizationExecution } from "./execution-graph.js";

function usage() {
  return `Usage:
  skill-customization supports <contract>
  skill-customization validate <customization.json> [--inventory inventory.json]
  skill-customization fingerprint <path>
  skill-customization payload-fingerprint <directory>
  skill-customization render-dispatcher <semantic-overlay|fork> --name name --description text [metadata options]
  skill-customization discover [name|repository|path] [--root path] [--custom-path path] [--include-plugins true|false]
  skill-customization bind <customization.json> --source path --context context [--scope global|workspace] [--state path] [--root path]
  skill-customization resolve <customization.json> --context context [--state path] [--root path]
  skill-customization reconcile <customization.json> --context context [--state path] [--root path] [--cache path] [--decision compatible|absorbed|incompatible|ambiguous] [--evidence text] [--absorbed-delta text]
  skill-customization preflight <customization.json> --context context [--state path] [--root path]
  skill-customization accept-maintenance <customization.json> [--source-effective fingerprint] [--diff-file path] [--reviewed-at timestamp] [--evidence text]
  skill-customization help

Options:
  -h, --help     Show this help
  -v, --version  Show the package version`;
}

async function packageVersion() {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  return packageJson.version;
}

const COMMAND_OPTIONS = Object.freeze({
  supports: new Set(),
  validate: new Set(["inventory"]),
  fingerprint: new Set(),
  "payload-fingerprint": new Set(),
  "render-dispatcher": new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "argument-hint",
    "disable-model-invocation",
    "user-invocable",
  ]),
  discover: new Set(["root", "custom-path", "include-plugins"]),
  bind: new Set(["source", "context", "scope", "state", "root"]),
  resolve: new Set(["context", "state", "root"]),
  reconcile: new Set([
    "context",
    "state",
    "root",
    "cache",
    "decision",
    "evidence",
    "absorbed-delta",
    "source",
  ]),
  preflight: new Set(["context", "state", "root"]),
  "accept-maintenance": new Set([
    "source-effective",
    "diff-file",
    "reviewed-at",
    "evidence",
  ]),
  help: new Set(),
});

const COMMAND_POSITIONAL_MAX = Object.freeze({
  supports: Number.MAX_SAFE_INTEGER,
  validate: 1,
  fingerprint: 1,
  "payload-fingerprint": 1,
  "render-dispatcher": 1,
  discover: 1,
  bind: 1,
  resolve: 1,
  reconcile: 1,
  preflight: 1,
  "accept-maintenance": 1,
  help: 0,
});

function parseArguments(command, argv) {
  const positionals = [];
  const options = {};
  const repeatable = new Set(["root", "absorbed-delta", "metadata"]);
  const allowed = COMMAND_OPTIONS[command];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!allowed.has(name)) {
      throw new TypeError(`unknown option --${name} for ${command}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new TypeError(`--${name} requires a value`);
    }
    index += 1;
    if (repeatable.has(name)) {
      options[name] ??= [];
      options[name].push(next);
    } else {
      if (command === "render-dispatcher" && Object.hasOwn(options, name)) {
        throw new TypeError(`duplicate --${name}`);
      }
      options[name] = next;
    }
  }
  return { positionals, options };
}

function parseBooleanOption(value, field) {
  if (value === undefined) return undefined;
  if (!["true", "false"].includes(value)) {
    throw new TypeError(`--${field} must be true or false`);
  }
  return value === "true";
}

function dispatcherMetadata(options) {
  const metadata = {};
  for (const field of [
    "name",
    "description",
    "license",
    "compatibility",
    "allowed-tools",
    "argument-hint",
  ]) {
    if (options[field] !== undefined) metadata[field] = options[field];
  }
  for (const field of ["disable-model-invocation", "user-invocable"]) {
    const value = parseBooleanOption(options[field], field);
    if (value !== undefined) metadata[field] = value;
  }
  if (options.metadata) {
    const entries = Object.create(null);
    for (const entry of options.metadata) {
      const separator = entry.indexOf("=");
      if (separator < 1) {
        throw new TypeError("--metadata must use key=value");
      }
      const key = entry.slice(0, separator);
      if (Object.hasOwn(entries, key)) {
        throw new TypeError(`duplicate --metadata key ${key}`);
      }
      entries[key] = entry.slice(separator + 1);
    }
    metadata.metadata = entries;
  }
  return metadata;
}

function outputJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandSupports(positionals, io) {
  const requested = positionals[0];
  const result = helperContractSupport(requested, await packageVersion());
  if (positionals.length !== 1 || !isValidHelperContract(requested)) {
    result.compatible = false;
  }
  outputJson(io, result);
  if (positionals.length === 0) {
    io.stderr.write("supports requires one helper contract\n");
    return 1;
  }
  if (positionals.length > 1) {
    io.stderr.write("supports accepts exactly one helper contract\n");
    return 1;
  }
  if (!isValidHelperContract(requested)) {
    io.stderr.write("helper contract must be a positive integer without leading zeroes\n");
    return 1;
  }
  if (!result.compatible) {
    io.stderr.write(
      `helper contract ${requested} is unsupported; supported contracts: ${result.supported_contracts.join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

async function ttyConfirmation(io, question) {
  if (!io.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: io.stdin, output: io.stderr });
  try {
    return /^(?:y|yes)$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

async function ttyBindingScope(io) {
  const prompt = readline.createInterface({ input: io.stdin, output: io.stderr });
  try {
    const scope = (await prompt.question("Binding scope (global/workspace): "))
      .trim()
      .toLowerCase();
    if (!["global", "workspace"].includes(scope)) {
      throw new TypeError("binding scope must be global or workspace");
    }
    return scope;
  } finally {
    prompt.close();
  }
}

function requireValue(value, message) {
  if (!value) throw new TypeError(message);
  return value;
}

async function discoveryContext(options = {}) {
  if (options.root) {
    return {
      roots: options.root.map((rootPath) => ({
        path: rootPath,
        owner: "cli-root",
        scope: options.scope ?? "custom",
        origin: "explicit-root",
      })),
      managerRecords: [],
      managerDiagnostics: [],
      hostDiagnostics: [],
      rootDiagnostics: [],
      settingsEvidence: [],
      settingsControlPaths: [],
      additionalRoots: [],
      includePlugins: false,
    };
  }
  const [configured, collected] = await Promise.all([
    configuredHostSkillRoots(),
    collectManagerRecords(),
  ]);
  return {
    roots: undefined,
    additionalRoots: configured.rootObservations,
    includePlugins: parseBooleanOption(options["include-plugins"], "include-plugins") ?? true,
    managerRecords: collected.records,
    managerDiagnostics: collected.diagnostics,
    hostDiagnostics: configured.diagnostics,
    rootDiagnostics: configured.rootDiagnostics,
    settingsEvidence: configured.settingsEvidence,
    settingsControlPaths: configured.settingsControlPaths,
  };
}

function discoveryOptions(context) {
  return {
    ...(context.roots === undefined ? {} : { roots: context.roots }),
    ...(context.additionalRoots?.length > 0
      ? { additionalRoots: context.additionalRoots }
      : {}),
    includePlugins: context.includePlugins,
    managerRecords: context.managerRecords,
    managerDiagnostics: context.managerDiagnostics,
    settingsEvidence: context.settingsEvidence,
    settingsControlPaths: context.settingsControlPaths,
    ...(context.rootDiagnostics?.length > 0
      ? { rootDiagnostics: context.rootDiagnostics }
      : {}),
  };
}

function createContextBindingOperation(context, statePath) {
  const resolvedStatePath = statePath ?? bindingStorePath();
  return createBindingRuntime({
    context: {
      ...context,
      statePath: resolvedStatePath,
      discoveryOptions: discoveryOptions(context),
    },
    inspectExecution: inspectCustomizationExecution,
  });
}

async function selectionFromPrompt({
  discovery,
  group,
  prompt,
  io,
  confirmationEvidence,
}) {
  let copy = group.copies[0];
  if (group.copies.length > 1) {
    group.copies.forEach((candidate, index) => {
      const ownership = candidate.owners?.length > 1
        ? candidate.owners.join(", ")
        : candidate.owner;
      io.stderr.write(
        `${index + 1}. ${candidate.path} (${ownership})\n`,
      );
    });
    const answer = Number(await prompt.question("Choose a copy: "));
    if (!Number.isInteger(answer) || answer < 1 || answer > group.copies.length) {
      throw new DiscoveryError("invalid copy choice", {
        code: "INVALID_DISCOVERY_CHOICE",
      });
    }
    copy = group.copies[answer - 1];
  }
  let confirmedProvenance;
  if (copy.conflict) {
    copy.provenance.forEach((value, index) => {
      io.stderr.write(`${index + 1}. ${value}\n`);
    });
    const answer = Number(await prompt.question("Confirm provenance: "));
    if (!Number.isInteger(answer) || answer < 1 || answer > copy.provenance.length) {
      throw new DiscoveryError("invalid provenance choice", {
        code: "INVALID_DISCOVERY_CHOICE",
      });
    }
    confirmedProvenance = copy.provenance[answer - 1];
  }
  return confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: copy.path,
      owner: copy.owner,
    },
    interactive: true,
    confirmedProvenance,
    confirmationEvidence,
  });
}

async function commandValidate(descriptorPath, options, io) {
  let inventory = [];
  if (options.inventory) inventory = JSON.parse(await readFile(options.inventory, "utf8"));
  const descriptor = await readDescriptor(requireValue(descriptorPath, "descriptor path is required"), {
    inventory,
  });
  outputJson(io, { valid: true, id: descriptor.id, name: descriptor.name });
}

function commandRenderDispatcher(customizationType, options, io) {
  io.stdout.write(renderDispatcher(customizationType, dispatcherMetadata(options)));
}

async function commandDiscover(input, options, io) {
  if (!input && !io.stdin.isTTY) {
    throw new DiscoveryError("discover needs an input in noninteractive mode", {
      code: "DISCOVERY_INPUT_REQUIRED",
    });
  }
  const context = await discoveryContext(options);
  const discovery = await discoverSkills({
    input,
    ...discoveryOptions(context),
    customPath: options["custom-path"],
  });
  discovery.managerDiagnostics = context.managerDiagnostics;
  discovery.hostDiagnostics = context.hostDiagnostics;
  discovery.settingsEvidence = context.settingsEvidence;
  if (input) {
    outputJson(io, discovery);
    return;
  }
  const prompt = readline.createInterface({ input: io.stdin, output: io.stderr });
  try {
    discovery.groups.forEach((group, index) => {
      io.stderr.write(`${index + 1}. ${group.name}\n`);
    });
    io.stderr.write(`${discovery.groups.length + 1}. custom path\n`);
    const answer = Number(await prompt.question("Choose a skill: "));
    if (!Number.isInteger(answer) || answer < 1 || answer > discovery.groups.length + 1) {
      throw new DiscoveryError("invalid discovery choice", {
        code: "INVALID_DISCOVERY_CHOICE",
      });
    }
    if (answer === discovery.groups.length + 1) {
      const custom = (await prompt.question("Custom path: ")).trim();
      const customDiscovery = await discoverSkills({
        input: custom,
        roots: discovery.searchedRoots,
        managerRecords: context.managerRecords,
        includePlugins: false,
      });
      if (customDiscovery.groups.length !== 1) {
        throw new DiscoveryError("custom path did not resolve one concrete skill", {
          code: "INVALID_DISCOVERY_CHOICE",
        });
      }
      const selection = await selectionFromPrompt({
        discovery: customDiscovery,
        group: customDiscovery.groups[0],
        prompt,
        io,
        confirmationEvidence: { method: "interactive-cli-custom-path" },
      });
      outputJson(io, { ...customDiscovery, selection });
      return;
    }
    const group = discovery.groups[answer - 1];
    const selection = await selectionFromPrompt({
      discovery,
      group,
      prompt,
      io,
      confirmationEvidence: { method: "interactive-cli" },
    });
    outputJson(io, { ...discovery, selection });
  } finally {
    prompt.close();
  }
}

async function commandBind(descriptorPath, options, io) {
  const resolvedDescriptorPath = path.resolve(
    requireValue(descriptorPath, "descriptor path is required"),
  );
  const descriptor = await readDescriptor(resolvedDescriptorPath);
  const sourcePath = requireValue(options.source, "--source is required");
  const bindingContext = requireValue(options.context, "--context is required");
  const context = await discoveryContext(options);
  const statePath = options.state ?? bindingStorePath();
  const bindingOperation = createContextBindingOperation(context, statePath);
  outputJson(
    io,
    await bindingOperation.bindCustomization({
      descriptor,
      sourcePath,
      context: bindingContext,
      customizationRoot: path.dirname(resolvedDescriptorPath),
      requestedScope: options.scope,
      requestScope: io.stdin.isTTY ? async () => ttyBindingScope(io) : undefined,
      interactive: io.stdin.isTTY,
      confirm: async () => ttyConfirmation(io, `Bind ${descriptor.name} to ${sourcePath}?`),
      confirmReplace: async () =>
        ttyConfirmation(
          io,
          `Replace ${descriptor.source.skill_name} with customization-first precedence?`,
        ),
      selectSource: io.stdin.isTTY
        ? async ({ discovery: sourceDiscovery, group }) => {
            const prompt = readline.createInterface({
              input: io.stdin,
              output: io.stderr,
            });
            try {
              return await selectionFromPrompt({
                discovery: sourceDiscovery,
                group,
                prompt,
                io,
                confirmationEvidence: {
                  method: "interactive-cli-binding",
                  customization: descriptor.id,
                  context: bindingContext,
                },
              });
            } finally {
              prompt.close();
            }
          }
        : undefined,
    }),
  );
}

async function commandResolve(descriptorPath, options, io) {
  const resolvedDescriptorPath = path.resolve(
    requireValue(descriptorPath, "descriptor path is required"),
  );
  const descriptor = await readDescriptor(resolvedDescriptorPath);
  const context = await discoveryContext(options);
  const statePath = options.state ?? bindingStorePath();
  const bindingOperation = createContextBindingOperation(context, statePath);
  outputJson(
    io,
    await bindingOperation.resolveBinding({
      descriptor,
      context: requireValue(options.context, "--context is required"),
      customizationRoot: path.dirname(resolvedDescriptorPath),
    }),
  );
}

async function commandReconcile(descriptorPath, options, io) {
  const resolvedDescriptorPath = path.resolve(
    requireValue(descriptorPath, "descriptor path is required"),
  );
  const descriptor = await readDescriptor(resolvedDescriptorPath);
  const statePath = options.state ?? bindingStorePath();
  if (options.source) {
    throw new TypeError(
      "--source cannot bypass binding; bind the source and reconcile with --context",
    );
  }
  let bindingContext;
  let reconciliationDiscoveryContext;
  if (descriptor.type === "semantic-overlay") {
    const context = await discoveryContext(options);
    bindingContext = requireValue(
      options.context,
      "--context is required for semantic overlay reconciliation",
    );
    reconciliationDiscoveryContext = {
      ...context,
      discoveryOptions: discoveryOptions(context),
    };
  }
  const decision = options.decision;
  if (decision && !["compatible", "absorbed", "incompatible", "ambiguous"].includes(decision)) {
    throw new TypeError("--decision must be compatible, absorbed, incompatible, or ambiguous");
  }
  const absorbedDeltas = options["absorbed-delta"] ?? [];
  if (decision === "absorbed" && absorbedDeltas.length === 0) {
    throw new TypeError("--decision absorbed requires at least one --absorbed-delta");
  }
  if (
    ["compatible", "incompatible"].includes(decision) &&
    !options.evidence?.trim()
  ) {
    throw new TypeError(`--decision ${decision} requires non-empty --evidence`);
  }
  const semanticReconciler = decision
    ? async () => ({
        compatible: decision === "compatible",
        ambiguous: decision === "ambiguous",
        absorbedDeltas: decision === "absorbed" ? absorbedDeltas : [],
        evidence: options.evidence,
      })
    : undefined;
  let result;
  try {
    result = await reconcileBoundCustomization({
      descriptor,
      customizationRoot: path.dirname(resolvedDescriptorPath),
      bindingContext,
      statePath,
      discoveryContext: reconciliationDiscoveryContext,
      cachePath: options.cache,
      semanticReconciler,
    });
  } catch (error) {
    if (error.code === "CUSTOMIZATION_SOURCE_NOT_READY") {
      throw new TypeError(error.message, { cause: error });
    }
    throw error;
  }
  outputJson(io, result);
  return result.stopped ? 2 : 0;
}

async function commandPreflight(descriptorPath, options, io) {
  const resolvedDescriptorPath = path.resolve(
    requireValue(descriptorPath, "descriptor path is required"),
  );
  const contextValue = requireValue(options.context, "--context is required");
  const context = await discoveryContext(options);
  const statePath = options.state ?? bindingStorePath();
  const result = await preflightCustomization({
    descriptorPath: resolvedDescriptorPath,
    context: contextValue,
    statePath,
    roots: context.roots,
    managerRecords: context.managerRecords,
    managerDiagnostics: context.managerDiagnostics,
    discoveryOptions: discoveryOptions(context),
  });
  outputJson(io, result);
  return result.status === "maintenance-required" ? 2 : 0;
}

async function commandAcceptMaintenance(descriptorPath, options, io) {
  const diffContents = options["diff-file"]
    ? await readFile(options["diff-file"], "utf8")
    : undefined;
  outputJson(
    io,
    await acceptMaintenanceUpdate({
      descriptorPath: requireValue(descriptorPath, "descriptor path is required"),
      sourceEffectiveFingerprint: options["source-effective"],
      diffContents,
      reviewedAt: options["reviewed-at"],
      evidence: options.evidence,
    }),
  );
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
      io.stdout.write(`${await packageVersion()}\n`);
      return 0;
    }
    const [command, ...rest] = argv;
    if (!command) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
      throw new TypeError(`unknown command ${command}`);
    }
    const { positionals, options } = parseArguments(command, rest);
    if (positionals.length > COMMAND_POSITIONAL_MAX[command]) {
      throw new TypeError(`too many positional arguments for ${command}`);
    }
    if (command === "help") {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (command === "supports") return await commandSupports(positionals, io);
    if (command === "validate") await commandValidate(positionals[0], options, io);
    else if (command === "fingerprint") {
      io.stdout.write(`${await fingerprintPath(requireValue(positionals[0], "path is required"))}\n`);
    } else if (command === "payload-fingerprint") {
      io.stdout.write(`${await payloadFingerprint(requireValue(positionals[0], "directory is required"))}\n`);
    } else if (command === "render-dispatcher") {
      commandRenderDispatcher(
        requireValue(positionals[0], "customization type is required"),
        options,
        io,
      );
    } else if (command === "discover") await commandDiscover(positionals[0], options, io);
    else if (command === "bind") await commandBind(positionals[0], options, io);
    else if (command === "resolve") await commandResolve(positionals[0], options, io);
    else if (command === "reconcile") return await commandReconcile(positionals[0], options, io);
    else if (command === "preflight") return await commandPreflight(positionals[0], options, io);
    else if (command === "accept-maintenance") {
      await commandAcceptMaintenance(positionals[0], options, io);
    }
    return 0;
  } catch (error) {
    const action = typeof error.details?.action === "string"
      ? `\nNext action: ${error.details.action}.`
      : "";
    io.stderr.write(
      `${error.code ? `${error.code}: ` : ""}${error.message}${action}\n`,
    );
    return 1;
  }
}
