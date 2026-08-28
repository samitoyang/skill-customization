import assert from "node:assert/strict";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedTestEnvironment } from "./test-environment.js";

export const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const emittedEntrypoints = Object.freeze([
  "package.json",
  "customization.schema.json",
  "bin/skill-customization.js",
  "dist/bin/skill-customization.js",
  "dist/bin/skill-customization.d.ts",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/index.js.map",
  "dist/src/index.d.ts.map",
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

const publicationDirectories = Object.freeze([
  "bin",
  "docs",
  "scripts",
  "skills",
  "src",
  "test",
  ".changeset",
  ".github",
]);

const emittedFixtureDirectories = Object.freeze([
  "docs",
  "skills",
  "test/fixtures",
  ".changeset",
  ".github",
]);

const publicationFiles = Object.freeze([
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "package.json",
  "README.md",
  "SECURITY.md",
  "customization.schema.json",
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

async function prepareOutputDirectory(root, outputDirectory, { replaceDefault = false } = {}) {
  assertSafeOutputDirectory(root, outputDirectory);
  const resolvedOutput = path.resolve(outputDirectory);
  const defaultOutput = path.join(path.resolve(root), "dist");
  if (replaceDefault && resolvedOutput === defaultOutput) {
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
  return resolvedOutput;
}

export async function buildTypescript({
  root = repositoryRoot,
  outputDirectory = path.join(root, "dist"),
} = {}) {
  const resolvedOutput = await prepareOutputDirectory(root, outputDirectory, {
    replaceDefault: true,
  });
  runCompiler(root, resolvedOutput);
  return { root, outputDirectory: resolvedOutput };
}

async function copyPublicationInputs(root, outputDirectory) {
  for (const relativePath of publicationFiles) {
    const source = path.join(root, relativePath);
    const target = path.join(outputDirectory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  for (const relativePath of publicationDirectories) {
    await cp(
      path.join(root, relativePath),
      path.join(outputDirectory, relativePath),
      { recursive: true },
    );
  }
}

async function copyEmittedFixtureInputs(root, emittedDirectory) {
  for (const relativePath of publicationFiles) {
    const target = path.join(emittedDirectory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relativePath), target);
  }
  for (const relativePath of emittedFixtureDirectories) {
    await cp(
      path.join(root, relativePath),
      path.join(emittedDirectory, relativePath),
      { recursive: true },
    );
  }
}

async function rebaseSourceMaps(root, publicationRoot, emittedDirectory) {
  const maps = (await filesBelow(emittedDirectory)).filter((file) => file.endsWith(".map"));
  for (const mapPath of maps) {
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
    sourceMap.sources = sourceMap.sources.map((source) => {
      const original = path.resolve(
        path.dirname(mapPath),
        sourceMap.sourceRoot ?? "",
        source,
      );
      const relative = path.relative(path.resolve(root), original);
      if (
        relative === ""
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new Error(`TypeScript source map escapes the repository: ${source}`);
      }
      return path.relative(
        path.dirname(mapPath),
        path.join(publicationRoot, relative),
      ).split(path.sep).join("/");
    });
    sourceMap.sourceRoot = "";
    await writeFile(mapPath, `${JSON.stringify(sourceMap)}\n`);
  }
}

export async function buildPublicationArtifact({
  root = repositoryRoot,
  outputDirectory,
} = {}) {
  if (!outputDirectory) {
    throw new TypeError("publication artifact requires an output directory");
  }
  const publicationRoot = await prepareOutputDirectory(root, outputDirectory);
  await copyPublicationInputs(root, publicationRoot);
  const emittedDirectory = path.join(publicationRoot, "dist");
  await mkdir(emittedDirectory);
  runCompiler(root, emittedDirectory);
  await copyEmittedFixtureInputs(root, emittedDirectory);
  await rebaseSourceMaps(root, publicationRoot, emittedDirectory);
  return { root, outputDirectory: publicationRoot, emittedDirectory };
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

async function assertSourceMaps(outputDirectory) {
  const emittedDirectory = path.join(outputDirectory, "dist");
  const files = await filesBelow(emittedDirectory);
  for (const file of files) {
    if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
    const mapPath = `${file}.map`;
    const contents = await readFile(file, "utf8");
    assert.match(contents, new RegExp(`sourceMappingURL=${path.basename(mapPath)}$`, "m"));
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
    assert.equal(sourceMap.version, 3);
    assert.equal(sourceMap.file, path.basename(file));
    assert.equal(typeof sourceMap.mappings, "string");
    assert.ok(sourceMap.sources.length > 0);
    for (const source of sourceMap.sources) {
      const sourceTarget = path.resolve(
        path.dirname(mapPath),
        sourceMap.sourceRoot ?? "",
        source,
      );
      assert.ok(
        sourceTarget === outputDirectory
        || sourceTarget.startsWith(`${outputDirectory}${path.sep}`),
      );
      await access(sourceTarget);
    }
  }
}

async function assertEmittedTestSuite(root, outputDirectory, { testConcurrency } = {}) {
  const tests = (await filesBelow(path.join(outputDirectory, "dist", "test")))
    .filter((file) => file.endsWith(".test.js"))
    .filter((file) => path.basename(file) !== "typescript-lane.test.js")
    .sort();
  if (tests.length === 0) throw new Error("TypeScript artifact emitted no test files");
  if (testConcurrency !== undefined
    && (!Number.isInteger(testConcurrency) || testConcurrency <= 0)) {
    throw new TypeError("emitted test concurrency must be a positive integer");
  }
  const isolated = await isolatedTestEnvironment();
  try {
    const result = spawnSync(process.execPath, [
      "--test",
      ...(testConcurrency === undefined ? [] : [`--test-concurrency=${testConcurrency}`]),
      ...tests,
    ], {
      cwd: isolated.cwd,
      encoding: "utf8",
      env: isolated.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "emitted test suite failed");
    }
  } finally {
    await isolated.cleanup();
  }
}

async function assertEmittedSchema(root, outputDirectory) {
  const source = JSON.parse(await readFile(path.join(root, "customization.schema.json"), "utf8"));
  const emitted = JSON.parse(
    await readFile(path.join(outputDirectory, "customization.schema.json"), "utf8"),
  );
  assert.deepEqual(emitted, source);
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
  const emittedCli = path.join(outputDirectory, "dist", "bin", "skill-customization.js");
  const legacyCli = path.join(outputDirectory, "bin", "skill-customization.js");
  for (const args of cliCases) {
    const sourceResult = runCli(sourceCli, args, root);
    for (const [label, entrypoint] of [
      ["emitted", emittedCli],
      ["legacy package", legacyCli],
    ]) {
      assert.deepEqual(
        runCli(entrypoint, args, outputDirectory),
        sourceResult,
        `${label} CLI differs for ${args.join(" ") || "no arguments"}`,
      );
    }
  }
}

async function assertLibraryContract(root, outputDirectory, packageVersion) {
  const [source, emitted] = await Promise.all([
    import(pathToFileURL(path.join(root, "src", "index.js")).href),
    import(pathToFileURL(path.join(outputDirectory, "dist", "src", "index.js")).href),
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
  const [rootRegistryDeclaration, indexDeclaration] = await Promise.all([
    readFile(
      path.join(outputDirectory, "dist", "src", "skill-root-registry.d.ts"),
      "utf8",
    ),
    readFile(path.join(outputDirectory, "dist", "src", "index.d.ts"), "utf8"),
  ]);
  assert.match(indexDeclaration, /export \* from "\.\/skill-root-registry\.js";/);
  const scanRecord = rootRegistryDeclaration.match(
    /export type SkillRootScanRecord = \{([\s\S]*?)\n\};/,
  );
  assert.ok(scanRecord, "emitted SkillRootScanRecord declaration is missing");
  const laterObservation = rootRegistryDeclaration.match(
    /export type LaterSkillRootObservation = \{([\s\S]*?)\n\};/,
  );
  assert.ok(
    laterObservation,
    "emitted LaterSkillRootObservation declaration is missing",
  );
  const standardObservation = rootRegistryDeclaration.match(
    /export type StandardSkillRootObservation = \{([\s\S]*?)\n\};/,
  );
  const configuredObservation = rootRegistryDeclaration.match(
    /export type ConfiguredSkillRootObservation = \{([\s\S]*?)\n\};/,
  );
  assert.ok(
    standardObservation && configuredObservation,
    "emitted standard root observation declarations are missing",
  );
  const pluginFieldTypes = new Map([
    ["host", "string"],
    ["plugin", "PluginRootMetadata"],
    ["pluginEvidence", "readonly import\\(\"\\.\\/provenance\\.js\"\\)\\.PluginProvenanceObservation\\[\\]"],
    ["pluginIdentities", "readonly string\\[\\]"],
    ["pluginIdentity", "string"],
    ["pluginManifest", "string"],
    ["pluginMetadata", "PluginRootMetadata"],
    ["pluginRoot", "string"],
    ["pluginRoots", "readonly string\\[\\]"],
  ]);
  for (const [field, type] of pluginFieldTypes) {
    const declaration = new RegExp(`\\b${field}\\?: ${type};`);
    assert.match(scanRecord[1], declaration);
    assert.match(laterObservation[1], declaration);
  }
  assert.match(
    laterObservation[1],
    /aliases\?: readonly string\[\];/,
  );
  assert.match(
    laterObservation[1],
    /owners\?: readonly string\[\];/,
  );
  for (const declaration of [standardObservation[1], configuredObservation[1]]) {
    assert.match(declaration, /aliases\?: readonly string\[\];/);
    assert.match(declaration, /owners\?: readonly string\[\];/);
  }
  assert.match(scanRecord[1], /aliases: readonly string\[\];/);
  assert.match(scanRecord[1], /owners: readonly string\[\];/);
}

function assertPublishedPackageContract(packageJson) {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=22.14.0");
  assert.equal(packageJson.main, "./dist/src/index.js");
  assert.equal(packageJson.types, "./dist/src/index.d.ts");
  assert.deepEqual(packageJson.exports?.["."], {
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
    default: "./dist/src/index.js",
  });
  assert.equal(packageJson.exports?.["./schema"], "./customization.schema.json");
  assert.deepEqual(Object.keys(packageJson.exports ?? {}), [".", "./schema"]);
  assert.equal(packageJson.bin?.["skill-customization"], "bin/skill-customization.js");
  assert.equal(packageJson.files?.includes("dist/src"), true);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.optionalDependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
}

export async function verifyEmittedArtifact({
  root = repositoryRoot,
  outputDirectory,
  testConcurrency,
} = {}) {
  if (!outputDirectory) throw new TypeError("TypeScript verification requires an output directory");
  const artifact = await buildPublicationArtifact({ root, outputDirectory });
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await assertFilesExist(artifact.outputDirectory);
  await assertEmittedSchema(root, artifact.outputDirectory);
  await assertSourceMaps(artifact.outputDirectory);
  await assertEmittedJavaScriptIsNodeCompatible(artifact.emittedDirectory);
  await assertCliContract(root, artifact.outputDirectory);
  await assertLibraryContract(root, artifact.outputDirectory, packageJson.version);
  await assertEmittedTestSuite(root, artifact.outputDirectory, { testConcurrency });
  assertPublishedPackageContract(packageJson);
  return artifact;
}
