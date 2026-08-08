import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  bindCustomization,
  bindingKey,
  readBindingStore,
  resolveBinding,
} from "../src/bindings.js";
import { discoverSkills } from "../src/discovery.js";
import { readDescriptor, validateDescriptor } from "../src/descriptor.js";
import {
  fingerprintFile,
  fingerprintFiles,
  fingerprintPath,
} from "../src/fingerprint.js";
import { reconcileCustomization } from "../src/reconcile.js";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/contract-v1/", import.meta.url),
);
const customizationRoot = path.join(fixtureRoot, "review-local-archive");
const descriptorPath = path.join(customizationRoot, "customization.json");
const checkpointRoot = path.join(fixtureRoot, "source-checkpoint", "review");
const liveRoot = path.join(fixtureRoot, "source-live", "review");
const bin = fileURLToPath(new URL("../bin/skill-customization.js", import.meta.url));

const readJson = async (target) => JSON.parse(await readFile(target, "utf8"));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function contractDescriptor() {
  return readDescriptor(descriptorPath);
}

async function contractSourceCheckout(prefix) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceRoot = path.join(repositoryRoot, "skills", "review");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "SKILL.md"),
    await readFile(path.join(liveRoot, "SKILL.md")),
  );
  return {
    sourceRoot,
    skillsRoot: path.dirname(sourceRoot),
  };
}

test("helper contract 1: descriptor v1 and fingerprint goldens remain stable", async () => {
  const [descriptor, golden] = await Promise.all([
    contractDescriptor(),
    readJson(path.join(fixtureRoot, "golden.json")),
  ]);
  assert.deepEqual(validateDescriptor(descriptor), []);
  assert.equal(descriptor.schema_version, 1);
  assert.deepEqual(
    {
      checkpoint_file: await fingerprintFile(path.join(checkpointRoot, "SKILL.md")),
      live_file: await fingerprintFile(path.join(liveRoot, "SKILL.md")),
      customization_semantics: await fingerprintFiles([
        path.join(customizationRoot, "SKILL.md"),
        path.join(customizationRoot, "CUSTOMIZATION.md"),
      ]),
      checkpoint_tree: await fingerprintPath(
        path.join(fixtureRoot, "source-checkpoint"),
      ),
    },
    golden.fingerprints,
  );
  const result = await reconcileCustomization({
    descriptor,
    customizationRoot,
    sourcePath: checkpointRoot,
    cachePath: null,
  });
  assert.deepEqual(result, golden.compatible_output);
});

test("helper contract 1: binding and compatibility cache v1 remain readable", async () => {
  const bindingPath = path.join(fixtureRoot, "binding-store.json");
  const expectedBindingStore = await readJson(bindingPath);
  const bindingStore = await readBindingStore(bindingPath);
  assert.deepEqual(bindingStore, expectedBindingStore);
  assert.ok(
    bindingStore.bindings[
      bindingKey(
        "urn:skill-customization:contract-v1:review-local-archive",
        "workspace:fixture",
      )
    ],
  );

  const descriptor = await contractDescriptor();
  const cached = await reconcileCustomization({
    descriptor,
    customizationRoot,
    sourcePath: liveRoot,
    cachePath: path.join(fixtureRoot, "compatibility-cache.json"),
  });
  assert.equal(cached.status, "compatible");
  assert.equal(cached.cached, true);
  assert.equal(cached.evidence, "contract-v1 golden semantic review");
});

test("helper contract 1: CLI output, diagnostics, and exit meanings remain stable", async () => {
  const [golden, packageJson] = await Promise.all([
    readJson(path.join(fixtureRoot, "golden.json")),
    readJson(new URL("../package.json", import.meta.url)),
  ]);
  const supported = await run(["supports", "1"]);
  assert.equal(supported.code, golden.exit_meanings.success);
  assert.equal(supported.stderr, "");
  assert.deepEqual(JSON.parse(supported.stdout), {
    ...golden.supports,
    package_version: packageJson.version,
  });
  const help = await run(["--help"]);
  assert.equal(help.code, golden.exit_meanings.success);
  for (const line of golden.usage_lines) assert.ok(help.stdout.includes(line));

  const malformed = await run(["supports", "1.0"]);
  assert.equal(malformed.code, golden.exit_meanings.error);
  assert.match(malformed.stderr, /positive integer/i);
  assert.equal(JSON.parse(malformed.stdout).compatible, false);

  const descriptor = await contractDescriptor();
  const { sourceRoot, skillsRoot } = await contractSourceCheckout(
    "contract-v1-exits-source-",
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contract-v1-exits-"));
  const statePath = path.join(temporary, "bindings.json");
  await bindCustomization({
    descriptor,
    sourcePath: sourceRoot,
    context: "workspace:contract-v1",
    statePath,
    roots: [{
      path: skillsRoot,
      scope: "workspace",
      origin: "project",
    }],
    interactive: true,
    confirm: async () => true,
  });
  const stopped = await run([
    "reconcile",
    descriptorPath,
    "--context",
    "workspace:contract-v1",
    "--state",
    statePath,
    "--root",
    skillsRoot,
    "--cache",
    path.join(temporary, "compatibility.json"),
  ]);
  assert.equal(stopped.code, golden.exit_meanings.stopped, stopped.stderr);
  assert.equal(stopped.stderr, "");
  assert.equal(JSON.parse(stopped.stdout).status, "ambiguous-drift");
});

test("helper contract 1: discovery and first-use binding semantics remain stable", async () => {
  const descriptor = await contractDescriptor();
  const { sourceRoot, skillsRoot } = await contractSourceCheckout(
    "contract-v1-binding-source-",
  );
  const roots = [{
    path: skillsRoot,
    scope: "workspace",
    origin: "project",
  }];
  const discovery = await discoverSkills({ input: "review", roots });
  assert.equal(discovery.groups.length, 1);
  assert.equal(discovery.groups[0].name, "review");
  assert.equal(discovery.groups[0].copies[0].path, sourceRoot);
  assert.deepEqual(discovery.groups[0].evidence, []);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "contract-v1-binding-"));
  const statePath = path.join(temporary, "bindings.json");
  await assert.rejects(
    bindCustomization({
      descriptor,
      sourcePath: sourceRoot,
      context: "workspace:contract-v1",
      statePath,
      roots,
      interactive: false,
    }),
    (error) => error.code === "FIRST_USE_CONFIRMATION_REQUIRED",
  );
  const created = await bindCustomization({
    descriptor,
    sourcePath: sourceRoot,
    context: "workspace:contract-v1",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(created.scope, "workspace");
  assert.equal(created.source.skillName, "review");
  assert.equal(created.source.confirmation, "user-confirmed");
  assert.deepEqual(
    await resolveBinding({
      descriptor,
      context: "workspace:contract-v1",
      statePath,
      roots,
    }),
    created,
  );
});

test("helper contract 1: reconciliation status vocabulary remains stable", async () => {
  const [descriptor, golden] = await Promise.all([
    contractDescriptor(),
    readJson(path.join(fixtureRoot, "golden.json")),
  ]);
  const statuses = new Set();
  const exact = await reconcileCustomization({
    descriptor,
    customizationRoot,
    sourcePath: checkpointRoot,
    cachePath: null,
  });
  statuses.add(exact.status);
  for (const outcome of [
    undefined,
    { compatible: false, absorbedDeltas: ["archive is upstream"] },
    { compatible: false, evidence: "delta conflicts" },
  ]) {
    const result = await reconcileCustomization({
      descriptor,
      customizationRoot,
      sourcePath: liveRoot,
      cachePath: null,
      ...(outcome ? { semanticReconciler: async () => outcome } : {}),
    });
    statuses.add(result.status);
    assert.equal(result.stopped, true);
  }

  const compatibleDrift = await reconcileCustomization({
    descriptor,
    customizationRoot,
    sourcePath: liveRoot,
    cachePath: null,
    semanticReconciler: async () => ({
      compatible: true,
      evidence: "delta remains compatible",
    }),
  });
  statuses.add(compatibleDrift.status);
  assert.equal(compatibleDrift.stopped, false);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "contract-v1-fork-"));
  const forkRoot = path.join(temporary, "review-standalone");
  const snapshotRoot = path.join(forkRoot, "provenance", "source");
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(forkRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(forkRoot, "CUSTOMIZATION.md"), "Independent fork.\n");
  await writeFile(path.join(snapshotRoot, "SKILL.md"), "snapshot\n");
  await writeFile(
    path.join(forkRoot, "provenance", "source.diff"),
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-snapshot\n+fork\n",
  );
  const forkDescriptor = {
    schema_version: 1,
    id: "urn:skill-customization:contract-v1:review-standalone",
    type: "fork",
    name: "review-standalone",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      review: {
        revision: "contract-v1-checkpoint",
        fingerprint: await fingerprintFile(path.join(snapshotRoot, "SKILL.md")),
      },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
    },
  };
  await writeFile(
    path.join(forkRoot, "customization.json"),
    `${JSON.stringify(forkDescriptor, null, 2)}\n`,
  );
  const fork = await reconcileCustomization({
    descriptor: forkDescriptor,
    customizationRoot: forkRoot,
  });
  statuses.add(fork.status);
  assert.equal(fork.runtimeSourceRequired, false);

  assert.deepEqual([...statuses].sort(), [...golden.reconciliation_statuses].sort());
});
