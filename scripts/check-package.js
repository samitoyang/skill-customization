import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  "docs/cli.md",
  "docs/descriptor-v1.md",
  "docs/discovery-and-bindings.md",
  "docs/helper-contract-1.md",
  "docs/helper-contract-2.md",
  "docs/library.md",
  "docs/reconciliation.md",
  "docs/adr/0001-managed-recursive-runtime.md",
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
  await verifyEmittedArtifact({
    root,
    outputDirectory: path.join(temporaryRoot, "typescript"),
  });
  const invocation = npmInvocation();
  const packed = spawnSync(
    invocation.command,
    [
      ...invocation.arguments,
      "pack",
      "--dry-run",
      "--ignore-scripts",
      "--json",
      "--cache",
      path.join(temporaryRoot, "npm-cache"),
    ],
    { cwd: root, encoding: "utf8" },
  );

  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "npm pack --dry-run failed");
  }

  const report = normalizeNpmPackReport(JSON.parse(packed.stdout));

  const files = new Set(report.files.map(({ path: file }) => file));
  const missing = requiredFiles.filter((file) => !files.has(file));
  const forbidden = [...files].filter(isForbiddenPackagePath);
  const emitted = [...files].filter((file) => file === "dist" || file.startsWith("dist/"));

  if (missing.length > 0) {
    throw new Error(`npm package is missing required files: ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    throw new Error(`npm package contains private files: ${forbidden.join(", ")}`);
  }
  if (emitted.length > 0) {
    throw new Error(`npm package contains TypeScript build output: ${emitted.join(", ")}`);
  }

  const cli = report.files.find(
    ({ path: file }) => file === "bin/skill-customization.js",
  );
  if ((cli.mode & 0o111) === 0) {
    throw new Error("npm package CLI is not executable");
  }

  process.stdout.write(
    `checked npm package (${report.entryCount} files, ${report.unpackedSize} bytes unpacked)\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
