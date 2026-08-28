import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeNpmPackReport } from "./npm-pack-report.js";
import { isForbiddenPackagePath } from "./package-path-policy.js";
import { verifyEmittedArtifact } from "./typescript-lane.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "skill-customization-pack-"));

const requiredFiles = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "bin/skill-customization.js",
  "customization.schema.json",
  "dist/src/index.d.ts",
  "dist/src/index.d.ts.map",
  "dist/src/index.js",
  "dist/src/index.js.map",
  "docs/cli.md",
  "docs/descriptor-v1.md",
  "docs/discovery-and-bindings.md",
  "docs/helper-contract-1.md",
  "docs/helper-contract-2.md",
  "docs/library.md",
  "docs/reconciliation.md",
  "docs/testing-and-performance.md",
  "docs/adr/0001-managed-recursive-runtime.md",
  "docs/adr/0002-bounded-plugin-provenance-discovery.md",
  "package.json",
  "skills/skill-fork/SKILL.md",
  "skills/skill-overlay/SKILL.md",
  "src/dispatcher-renderer.js",
  "src/index.js",
  "src/maintenance.js",
  "src/owned-payload.js",
  "src/preflight.js",
];

function npmInvocation() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      arguments: [process.env.npm_execpath],
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    arguments: [],
  };
}

try {
  const artifact = await verifyEmittedArtifact({
    root,
    outputDirectory: path.join(temporaryRoot, "artifact"),
  });
  const invocation = npmInvocation();
  const packed = spawnSync(
    invocation.command,
    [
      ...invocation.arguments,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryRoot,
      "--cache",
      path.join(temporaryRoot, "npm-cache"),
    ],
    { cwd: artifact.outputDirectory, encoding: "utf8" },
  );

  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "npm pack --dry-run failed");
  }

  const report = normalizeNpmPackReport(JSON.parse(packed.stdout));

  const files = new Set(report.files.map(({ path: file }) => file));
  const missing = requiredFiles.filter((file) => !files.has(file));
  const forbidden = [...files].filter(isForbiddenPackagePath);

  if (missing.length > 0) {
    throw new Error(`npm package is missing required files: ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    throw new Error(`npm package contains private files: ${forbidden.join(", ")}`);
  }
  const cli = report.files.find(
    ({ path: file }) => file === "bin/skill-customization.js",
  );
  if ((cli.mode & 0o111) === 0) {
    throw new Error("npm package CLI is not executable");
  }

  const consumer = path.join(temporaryRoot, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    '{"name":"package-consumer","private":true,"type":"module"}\n',
  );
  await writeFile(
    path.join(consumer, "index.mjs"),
    `import {
  DescriptorError,
  helperContractSupport,
  normalizeRepositoryUrl,
  renderDispatcher,
} from "skill-customization";

const support = helperContractSupport("2", ${JSON.stringify(report.version)});
if (!support.compatible) throw new Error("helper contract was not compatible");
if (normalizeRepositoryUrl("git@github.com:example/skills.git") !== "https://github.com/example/skills") {
  throw new Error("repository normalization changed");
}
const dispatcher = renderDispatcher("semantic-overlay", {
  name: "package-consumer",
  description: "Exercise the packed public interface.",
  "disable-model-invocation": true,
});
if (!dispatcher.includes("skill-overlay")) throw new Error("dispatcher contract changed");
const error = new DescriptorError("invalid", { path: "/name" });
if (error.code !== "INVALID_DESCRIPTOR") throw new Error("error contract changed");
`,
  );
  await writeFile(
    path.join(consumer, "index.ts"),
    `import {
  assertValidDescriptor,
  helperContractSupport,
  preflightCustomization,
  reconcileBoundCustomization,
  validateDescriptor,
} from "skill-customization";
import type {
  CustomizationDescriptor,
  DescriptorValidationError,
  ProvenanceDecision,
  SkillRootScanRecord,
} from "skill-customization";

const descriptor: CustomizationDescriptor = assertValidDescriptor({});
const errors: DescriptorValidationError[] = validateDescriptor(descriptor);
const support: { compatible: boolean; requested_contract: string | null } =
  helperContractSupport("2", ${JSON.stringify(report.version)});
const roots: SkillRootScanRecord[] = [];
const preflight: Promise<unknown> = preflightCustomization({
  descriptorPath: "/tmp/customization.json",
  context: "package-consumer",
  roots,
  managerDiagnostics: [],
  discovery: undefined,
});
const reconciliation: Promise<unknown> = reconcileBoundCustomization({
  descriptor,
  customizationRoot: "/tmp/customization",
  bindingContext: "package-consumer",
  discoveryContext: { roots },
});
declare const decision: ProvenanceDecision;
void errors;
void support;
void preflight;
void reconciliation;
void decision;

// @ts-expect-error Internal implementation seams are not package exports.
await import("skill-customization/src/internal/reconciliation-runtime.js");
`,
  );

  const archive = path.join(temporaryRoot, report.filename);
  const installed = spawnSync(
    invocation.command,
    [
      ...invocation.arguments,
      "install",
      "--ignore-scripts",
      "--offline",
      "--cache",
      path.join(temporaryRoot, "npm-cache"),
      archive,
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  if (installed.status !== 0) {
    throw new Error(installed.stderr || installed.stdout || "packed consumer install failed");
  }

  const consumed = spawnSync(process.execPath, ["index.mjs"], {
    cwd: consumer,
    encoding: "utf8",
  });
  if (consumed.status !== 0) {
    throw new Error(consumed.stderr || consumed.stdout || "packed JavaScript consumer failed");
  }

  const typed = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "index.ts",
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  if (typed.status !== 0) {
    throw new Error(typed.stderr || typed.stdout || "packed TypeScript consumer failed");
  }

  const installedCli = spawnSync(
    path.join(consumer, "node_modules", ".bin", "skill-customization"),
    ["supports", "2"],
    { cwd: consumer, encoding: "utf8" },
  );
  if (installedCli.status !== 0) {
    throw new Error(installedCli.stderr || installedCli.stdout || "packed CLI failed");
  }
  const cliResult = JSON.parse(installedCli.stdout);
  if (cliResult.compatible !== true || cliResult.requested_contract !== "2") {
    throw new Error("packed CLI returned an invalid helper contract result");
  }

  process.stdout.write(
    `checked verified npm package (${report.entryCount} files, ${report.unpackedSize} bytes unpacked)\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
