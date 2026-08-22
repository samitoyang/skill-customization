import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const emittedEntrypoints = Object.freeze([
  "package.json",
  "bin/skill-customization.js",
  "bin/skill-customization.d.ts",
  "src/index.js",
  "src/index.d.ts",
  "src/index.js.map",
  "src/index.d.ts.map",
]);

const cliCases = Object.freeze([
  ["--version"],
  ["help"],
  ["supports", "1"],
  ["supports", "2"],
  ["supports", "3"],
  ["supports"],
  ["supports", "1", "extra"],
  ["unknown-command"],
]);

function compilerPath(root) {
  return path.join(root, "node_modules", "typescript", "bin", "tsc");
}

function assertSafeOutputDirectory(root, outputDirectory) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputDirectory);
  if (
    resolvedRoot === resolvedOutput
    || resolvedOutput === path.parse(resolvedOutput).root
    || resolvedRoot.startsWith(`${resolvedOutput}${path.sep}`)
  ) {
    throw new Error(`TypeScript output directory must not be ${resolvedOutput}`);
  }
}

function runCompiler(root, outputDirectory) {
  const result = spawnSync(
    process.execPath,
    [
      compilerPath(root),
      "--project",
      path.join(root, "tsconfig.json"),
      "--outDir",
      outputDirectory,
      "--pretty",
      "false",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "TypeScript compilation failed");
  }
}

export async function buildTypescript({ root = repositoryRoot, outputDirectory = path.join(root, "dist") } = {}) {
  assertSafeOutputDirectory(root, outputDirectory);
  const resolvedOutput = path.resolve(outputDirectory);
  const defaultOutput = path.join(path.resolve(root), "dist");
  if (resolvedOutput === defaultOutput) {
    await rm(resolvedOutput, { recursive: true, force: true });
  } else {
    try {
      await access(resolvedOutput);
      throw new Error(`TypeScript output directory already exists: ${resolvedOutput}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(resolvedOutput);
  runCompiler(root, resolvedOutput);
  await copyFile(path.join(root, "package.json"), path.join(resolvedOutput, "package.json"));
  return { root, outputDirectory: resolvedOutput };
}

async function assertFilesExist(outputDirectory) {
  for (const relativePath of emittedEntrypoints) {
    await access(path.join(outputDirectory, relativePath));
  }
}

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(target)));
    else result.push(target);
  }
  return result;
}

async function assertEmittedJavaScriptIsNodeCompatible(outputDirectory) {
  const javascript = (await filesBelow(outputDirectory)).filter((file) => file.endsWith(".js"));
  for (const file of javascript) {
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (checked.status !== 0) throw new Error(checked.stderr || `syntax check failed: ${file}`);
  }
}

async function assertSourceMap(root, outputDirectory, emittedPath, mapPath, sourcePath = emittedPath) {
  const javascript = await readFile(path.join(outputDirectory, emittedPath), "utf8");
  assert.match(javascript, new RegExp(`sourceMappingURL=${path.basename(mapPath)}$`, "m"));
  const resolvedMapPath = path.join(outputDirectory, mapPath);
  const sourceMap = JSON.parse(await readFile(resolvedMapPath, "utf8"));
  assert.equal(sourceMap.version, 3);
  const sourceTarget = path.resolve(root, sourcePath);
  assert.ok(
    sourceMap.sources.some((source) =>
      path.resolve(path.dirname(resolvedMapPath), sourceMap.sourceRoot ?? "", source)
      === sourceTarget
    ),
  );
}

function runCli(entrypoint, args, root) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function assertCliContract(root, outputDirectory) {
  const sourceCli = path.join(root, "bin", "skill-customization.js");
  const emittedCli = path.join(outputDirectory, "bin", "skill-customization.js");
  for (const args of cliCases) {
    assert.deepEqual(
      runCli(emittedCli, args, root),
      runCli(sourceCli, args, root),
      `emitted CLI differs for ${args.join(" ") || "no arguments"}`,
    );
  }
}

async function assertLibraryContract(root, outputDirectory, packageVersion) {
  const [source, emitted] = await Promise.all([
    import(pathToFileURL(path.join(root, "src", "index.js")).href),
    import(pathToFileURL(path.join(outputDirectory, "src", "index.js")).href),
  ]);
  assert.deepEqual(Object.keys(emitted).sort(), Object.keys(source).sort());
  for (const contract of ["1", "2", "3", "01"]) {
    assert.deepEqual(
      emitted.helperContractSupport(contract, packageVersion),
      source.helperContractSupport(contract, packageVersion),
    );
    assert.equal(emitted.isValidHelperContract(contract), source.isValidHelperContract(contract));
  }
  const metadata = {
    name: "review-local-archive",
    description: "Review work and archive the result locally.",
    "disable-model-invocation": true,
  };
  assert.equal(
    emitted.renderDispatcher("semantic-overlay", metadata),
    source.renderDispatcher("semantic-overlay", metadata),
  );
}

function assertPublishedPackageContract(packageJson) {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=22.14.0");
  assert.equal(packageJson.main, "./src/index.js");
  assert.equal(packageJson.exports?.["."], "./src/index.js");
  assert.equal(packageJson.bin?.["skill-customization"], "bin/skill-customization.js");
  assert.equal(packageJson.files?.includes("dist"), false);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.optionalDependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
}

export async function verifyEmittedArtifact({ root = repositoryRoot, outputDirectory } = {}) {
  if (!outputDirectory) throw new TypeError("TypeScript verification requires an output directory");
  const artifact = await buildTypescript({ root, outputDirectory });
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await assertFilesExist(artifact.outputDirectory);
  await assertSourceMap(root, artifact.outputDirectory, "src/index.js", "src/index.js.map");
  await assertSourceMap(
    root,
    artifact.outputDirectory,
    "src/index.d.ts",
    "src/index.d.ts.map",
    "src/index.js",
  );
  await assertEmittedJavaScriptIsNodeCompatible(artifact.outputDirectory);
  await assertCliContract(root, artifact.outputDirectory);
  await assertLibraryContract(root, artifact.outputDirectory, packageJson.version);
  assertPublishedPackageContract(packageJson);
  return artifact;
}
