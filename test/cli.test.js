import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bindCustomization } from "../src/bindings.js";
import { renderDispatcher } from "../src/dispatcher-renderer.js";
import {
  fingerprintFile,
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { main } from "../src/cli.js";

const bin = fileURLToPath(new URL("../bin/skill-customization.js", import.meta.url));

function run(args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runInteractive(args, answers) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  let stdout = "";
  let stderr = "";
  let answerIndex = 0;
  const sink = (append) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  const stderrSink = sink((value) => {
    stderr += value;
    if (value.includes("[y/N]") && answerIndex < answers.length) {
      const answer = answers[answerIndex];
      answerIndex += 1;
      setImmediate(() => stdin.write(`${answer}\n`));
    }
  });
  const result = main(args, {
    stdin,
    stdout: sink((value) => (stdout += value)),
    stderr: stderrSink,
  });
  const code = await result;
  stdin.end();
  if (answerIndex !== answers.length) {
    throw new Error(`interactive CLI consumed ${answerIndex} of ${answers.length} answers`);
  }
  return { code, stdout, stderr };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-"));
  const custom = path.join(root, "review-local-archive");
  const source = path.join(root, "source", "review");
  await mkdir(custom, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(custom, "SKILL.md"), "custom\n");
  await writeFile(path.join(custom, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: review\n---\nsource\n",
  );
  const fingerprint = await fingerprintPath(source);
  const owned = await payloadFingerprint(custom);
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-local-archive",
    type: "semantic-overlay",
    name: "review-local-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: fingerprint,
      review: { revision: "abc" },
    },
    activation: { mode: "coexist" },
  };
  const descriptorPath = path.join(custom, "customization.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  return { root, custom, source, descriptorPath, descriptor };
}

test("CLI validates, fingerprints, discovers, binds, resolves, and reconciles", async () => {
  const item = await fixture();
  assert.equal((await run(["validate", item.descriptorPath])).code, 0);
  const fingerprint = await run(["fingerprint", path.join(item.source, "SKILL.md")]);
  assert.equal(fingerprint.code, 0);
  assert.match(fingerprint.stdout, /^sha256:[0-9a-f]{64}\s*$/);
  const payload = await run(["payload-fingerprint", item.custom]);
  assert.equal(payload.code, 0);
  assert.equal(payload.stdout.trim(), item.descriptor.owned_payload.reviewed_fingerprint);
  const discovered = await run(["discover", item.source, "--root", path.dirname(item.source)]);
  assert.equal(discovered.code, 0, discovered.stderr);
  assert.equal(JSON.parse(discovered.stdout).groups[0].name, "review");
  const missingInput = await run(["discover", "--root", path.dirname(item.source)]);
  assert.notEqual(missingInput.code, 0);
  assert.match(missingInput.stderr, /input.*noninteractive/i);

  const state = path.join(item.root, "state", "bindings.json");
  const refused = await run([
    "bind",
    item.descriptorPath,
    "--source",
    item.source,
    "--context",
    "global",
    "--root",
    path.dirname(item.source),
    "--state",
    state,
  ]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /confirmation/i);
  await bindCustomization({
    descriptor: item.descriptor,
    sourcePath: item.source,
    context: "global",
    statePath: state,
    roots: [{ path: path.dirname(item.source), scope: "global", origin: "personal" }],
    interactive: true,
    confirm: async () => true,
  });
  assert.equal(
    (
      await run([
        "resolve",
        item.descriptorPath,
        "--context",
        "global",
        "--state",
        state,
        "--root",
        path.dirname(item.source),
      ])
    ).code,
    0,
  );
  const reconciledFromBinding = await run([
    "reconcile",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
  ]);
  assert.equal(reconciledFromBinding.code, 0, reconciledFromBinding.stderr);
  assert.equal(JSON.parse(reconciledFromBinding.stdout).status, "compatible");
  const ready = await run([
    "preflight",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
  ]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, "ready");
  const directBypass = await run([
    "reconcile",
    item.descriptorPath,
    "--source",
    item.source,
  ]);
  assert.equal(directBypass.code, 1);
  assert.match(directBypass.stderr, /cannot bypass binding/i);
  await writeFile(
    path.join(item.source, "SKILL.md"),
    "---\nname: review\n---\nreviewed drift\n",
  );
  const maintenance = await run([
    "preflight",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
  ]);
  assert.equal(maintenance.code, 2, maintenance.stderr);
  assert.equal(JSON.parse(maintenance.stdout).status, "maintenance-required");
  const cache = path.join(item.root, "state", "compatibility.json");
  const stopped = await run([
    "reconcile",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
    "--cache",
    cache,
  ]);
  assert.equal(stopped.code, 2, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).status, "ambiguous-drift");
  const unevidenced = await run([
    "reconcile",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
    "--cache",
    cache,
    "--decision",
    "compatible",
  ]);
  assert.equal(unevidenced.code, 1);
  assert.match(unevidenced.stderr, /requires.*evidence/i);
  const reviewed = await run([
    "reconcile",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
    "--cache",
    cache,
    "--decision",
    "compatible",
    "--evidence",
    "agent reviewed the documented delta",
  ]);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).cached, false);
  const cached = await run([
    "reconcile",
    item.descriptorPath,
    "--context",
    "global",
    "--state",
    state,
    "--root",
    path.dirname(item.source),
    "--cache",
    cache,
  ]);
  assert.equal(cached.code, 0, cached.stderr);
  assert.equal(JSON.parse(cached.stdout).cached, true);
});

test("CLI binding commands exclude the active replacement customization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-replacement-inventory-"));
  const sourceParent = path.join(root, "sources");
  const customizationParent = path.join(root, "customizations");
  const source = path.join(sourceParent, "review");
  const customization = path.join(customizationParent, "review");
  const statePath = path.join(root, "state", "bindings.json");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\nSource.\n");
  await mkdir(customization, { recursive: true });
  await writeFile(
    path.join(customization, "SKILL.md"),
    "---\nname: review\n---\nDispatcher.\n",
  );
  await writeFile(path.join(customization, "CUSTOMIZATION.md"), "Replacement delta.\n");
  const descriptor = {
    schema_version: 1,
    id: "urn:test:cli-replacement-review",
    type: "semantic-overlay",
    name: "review",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(customization) },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: await fingerprintPath(source),
      review: { revision: "cli-replacement-review" },
    },
    activation: { mode: "replace", precedence: "customization-first" },
  };
  const descriptorPath = path.join(customization, "customization.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const common = [
    "--context",
    "workspace:test",
    "--state",
    statePath,
    "--root",
    sourceParent,
    "--root",
    customizationParent,
  ];

  const bound = await runInteractive([
    "bind",
    descriptorPath,
    "--source",
    source,
    "--scope",
    "workspace",
    ...common,
  ], ["yes", "yes"]);
  assert.equal(bound.code, 0, bound.stderr);

  const resolved = await run(["resolve", descriptorPath, ...common]);
  assert.equal(resolved.code, 0, resolved.stderr);
  const reconciled = await run(["reconcile", descriptorPath, ...common]);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  assert.equal(JSON.parse(reconciled.stdout).status, "compatible");
});

test("CLI validation rejects a runtime selector symlink into reserved provenance", async () => {
  const item = await fixture();
  await mkdir(path.join(item.custom, "provenance"));
  await writeFile(path.join(item.custom, "provenance", "runtime.md"), "unchecked\n");
  await symlink("provenance/runtime.md", path.join(item.custom, "RUN.md"));
  item.descriptor.entrypoint = "RUN.md";
  await writeFile(item.descriptorPath, JSON.stringify(item.descriptor));

  const result = await run(["validate", item.descriptorPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /excluded owned-payload path/i);
});

test("CLI reconciliation preflights a nested customization source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-nested-reconcile-"));
  const nested = path.join(root, "review-fork");
  const nestedAlias = path.join(root, "installed-review-fork");
  const snapshot = path.join(nested, "provenance", "source");
  const outer = path.join(root, "review-fork-notify");
  await mkdir(snapshot, { recursive: true });
  await mkdir(outer);
  await writeFile(
    path.join(nested, "SKILL.md"),
    "---\nname: review-fork\n---\nfork\n",
  );
  await writeFile(path.join(nested, "CUSTOMIZATION.md"), "Fork rationale.\n");
  await writeFile(
    path.join(snapshot, "SKILL.md"),
    "---\nname: review-fork\n---\nsnapshot\n",
  );
  const diffPath = path.join(nested, "provenance", "source.diff");
  await writeFile(
    diffPath,
    [
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -1,4 +1,4 @@",
      " ---",
      " name: review-fork",
      " ---",
      "-snapshot",
      "+fork",
      "--- /dev/null",
      "+++ b/CUSTOMIZATION.md",
      "@@ -0,0 +1 @@",
      "+Fork rationale.",
      "",
    ].join("\n"),
  );
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const nestedOwned = await payloadFingerprint(nested);
  const nestedDescriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-fork",
    type: "fork",
    name: "review-fork",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: nestedOwned },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: { revision: "reviewed" },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  await writeFile(
    path.join(nested, "customization.json"),
    JSON.stringify(nestedDescriptor),
  );
  await symlink(nested, nestedAlias);
  const nestedEffective = fingerprintValues(
    [nestedDescriptor.id, "workflow", nestedDescriptor.customization, nestedOwned],
    "skill-customization-fork-effective-v1",
  );

  await writeFile(
    path.join(outer, "SKILL.md"),
    "---\nname: review-fork-notify\n---\ndispatch\n",
  );
  await writeFile(path.join(outer, "CUSTOMIZATION.md"), "Notify after review.\n");
  const outerDescriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-fork-notify",
    type: "semantic-overlay",
    name: "review-fork-notify",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(outer) },
    source: {
      skill_name: nestedDescriptor.name,
      kind: "customization",
      id: nestedDescriptor.id,
      type: nestedDescriptor.type,
      license: nestedDescriptor.license,
      effective_fingerprint: nestedEffective,
    },
    activation: { mode: "coexist" },
  };
  const outerDescriptorPath = path.join(outer, "customization.json");
  await writeFile(outerDescriptorPath, JSON.stringify(outerDescriptor));
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
  await bindCustomization({
    descriptor: outerDescriptor,
    sourcePath: nestedAlias,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
  });

  const result = await run([
    "reconcile",
    outerDescriptorPath,
    "--context",
    "workspace:test",
    "--state",
    statePath,
    "--root",
    root,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceFingerprint, nestedEffective);

  outerDescriptor.source.effective_fingerprint =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  await writeFile(outerDescriptorPath, JSON.stringify(outerDescriptor));
  const reviewed = await run([
    "reconcile",
    outerDescriptorPath,
    "--context",
    "workspace:test",
    "--state",
    statePath,
    "--root",
    root,
    "--cache",
    path.join(root, "state", "compatibility.json"),
    "--decision",
    "compatible",
    "--evidence",
    "Reviewed the checked nested workflow plan.",
  ]);
  assert.equal(reviewed.code, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).status, "compatible");
  assert.equal(JSON.parse(reviewed.stdout).sourceFingerprint, nestedEffective);
});

test("CLI discovery loads bounded Claude additionalDirectories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-claude-settings-"));
  const home = path.join(root, "home");
  const additional = path.join(root, "team");
  const skill = path.join(
    additional,
    ".claude",
    "skills",
    "claude-cli-fixture",
  );
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ additionalDirectories: [additional] }),
  );
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: claude-cli-fixture\n---\nfixture\n",
  );

  const result = await run(["discover", "claude-cli-fixture"], {
    env: { ...process.env, HOME: home, PATH: "" },
  });
  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].name, "claude-cli-fixture");
  assert.equal(discovery.groups[0].copies[0].owner, "claude-additional");
  assert.equal(discovery.settingsEvidence.length, 1);
});

test("CLI accepts an explicit owned-payload maintenance update atomically", async () => {
  const item = await fixture();
  await writeFile(
    path.join(item.custom, "CUSTOMIZATION.md"),
    "Reviewed replacement delta.\n",
  );
  const result = await run(["accept-maintenance", item.descriptorPath]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const payload = await run(["payload-fingerprint", item.custom]);
  assert.equal(output.ownedPayloadFingerprint, payload.stdout.trim());
});

test("CLI accepts standard top-level help flags", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await run([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
  }
});

test("CLI renders exact canonical dispatchers for overlays and forks", async () => {
  for (const [type, metadata, options] of [
    [
      "semantic-overlay",
      {
        name: "review-local-archive",
        description: "Review work and archive the result locally.",
        license: "MIT",
        compatibility: "Requires Node.js 18+",
        metadata: { author: "example-org", version: "1.0" },
        "allowed-tools": "Read Bash(git:*)",
        "argument-hint": "Repository or pull request to review",
        "disable-model-invocation": true,
        "user-invocable": false,
      },
      [
        "--name", "review-local-archive",
        "--description", "Review work and archive the result locally.",
        "--license", "MIT",
        "--compatibility", "Requires Node.js 18+",
        "--metadata", "version=1.0",
        "--metadata", "author=example-org",
        "--allowed-tools", "Read Bash(git:*)",
        "--argument-hint", "Repository or pull request to review",
        "--disable-model-invocation", "true",
        "--user-invocable", "false",
      ],
    ],
    [
      "fork",
      {
        name: "review-local",
        description: "Review work with an independent local workflow.",
      },
      [
        "--name", "review-local",
        "--description", "Review work with an independent local workflow.",
      ],
    ],
  ]) {
    const result = await run(["render-dispatcher", type, ...options]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, renderDispatcher(type, metadata));
  }
});

test("CLI rejects duplicate dispatcher metadata", async () => {
  const duplicateField = await run([
    "render-dispatcher",
    "fork",
    "--name", "review-local",
    "--name", "other-name",
    "--description", "Review locally.",
  ]);
  assert.equal(duplicateField.code, 1);
  assert.match(duplicateField.stderr, /duplicate --name/i);

  const duplicateNestedKey = await run([
    "render-dispatcher",
    "fork",
    "--name", "review-local",
    "--description", "Review locally.",
    "--metadata", "author=one",
    "--metadata", "author=two",
  ]);
  assert.equal(duplicateNestedKey.code, 1);
  assert.match(duplicateNestedKey.stderr, /duplicate --metadata key author/i);
});

test("CLI reports the package version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const flag of ["--version", "-v"]) {
    const result = await run([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), packageJson.version);
  }
});

test("CLI reports both supported helper contracts as structured JSON", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const contract of ["1", "2"]) {
    const result = await run(["supports", contract]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      compatible: true,
      requested_contract: contract,
      supported_contracts: ["1", "2"],
      package_version: packageJson.version,
    });
  }
});

test("CLI returns structured incompatibility for unsupported and malformed contracts", async () => {
  for (const [contract, diagnostic] of [
    ["3", /unsupported/i],
    ["1.0", /positive integer/i],
    ["01", /positive integer/i],
  ]) {
    const result = await run(["supports", contract]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, diagnostic);
    const output = JSON.parse(result.stdout);
    assert.equal(output.compatible, false);
    assert.equal(output.requested_contract, contract);
    assert.deepEqual(output.supported_contracts, ["1", "2"]);
    assert.equal(typeof output.package_version, "string");
    assert.deepEqual(Object.keys(output), [
      "compatible",
      "requested_contract",
      "supported_contracts",
      "package_version",
    ]);
  }
});

test("CLI contract checks keep their JSON shape for missing and extra arguments", async () => {
  for (const args of [["supports"], ["supports", "1", "extra"]]) {
    const result = await run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires one|exactly one/i);
    const output = JSON.parse(result.stdout);
    assert.equal(output.compatible, false);
    assert.ok(output.requested_contract === null || output.requested_contract === "1");
    assert.deepEqual(output.supported_contracts, ["1", "2"]);
    assert.equal(typeof output.package_version, "string");
  }
});

test("CLI rejects unknown long options for every command", async (t) => {
  const commandArguments = {
    supports: ["1"],
    validate: ["customization.json"],
    fingerprint: ["SKILL.md"],
    "payload-fingerprint": ["customization"],
    "render-dispatcher": ["fork"],
    discover: ["review"],
    bind: ["customization.json"],
    resolve: ["customization.json"],
    reconcile: ["customization.json"],
    preflight: ["customization.json"],
    "accept-maintenance": ["customization.json"],
    help: [],
  };
  for (const [command, argumentsForCommand] of Object.entries(commandArguments)) {
    await t.test(command, async () => {
      const result = await run([
        command,
        ...argumentsForCommand,
        "--unknown-option",
        "value",
      ]);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        new RegExp(`unknown option --unknown-option for ${command}`, "i"),
      );
    });
  }
});

test("CLI rejects extra positional arguments for every command", async (t) => {
  const commandArguments = {
    supports: ["1", "extra"],
    validate: ["customization.json", "extra"],
    fingerprint: ["SKILL.md", "extra"],
    "payload-fingerprint": ["customization", "extra"],
    "render-dispatcher": ["fork", "extra"],
    discover: ["review", "extra"],
    bind: ["customization.json", "extra"],
    resolve: ["customization.json", "extra"],
    reconcile: ["customization.json", "extra"],
    preflight: ["customization.json", "extra"],
    "accept-maintenance": ["customization.json", "extra"],
    help: ["extra"],
  };
  for (const [command, argumentsForCommand] of Object.entries(commandArguments)) {
    await t.test(command, async () => {
      const result = await run([command, ...argumentsForCommand]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, command === "supports"
        ? /exactly one helper contract/i
        : new RegExp(`too many positional arguments for ${command}`, "i"));
    });
  }
});

test("CLI missing-source errors state the required next action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-missing-source-"));
  const result = await run([
    "discover",
    "https://github.com/example/missing/tree/main/skills/review",
    "--root",
    root,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /install, clone, create, or choose a custom path/i);
});

test("interactive custom-path discovery records final confirmation evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-custom-picker-"));
  const emptyRoot = path.join(root, "empty");
  const skill = path.join(root, "custom-review");
  await mkdir(emptyRoot);
  await mkdir(skill);
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: custom-review\n---\nfixture\n",
  );
  const stdin = new PassThrough();
  stdin.isTTY = true;
  let stdout = "";
  let stderr = "";
  const sink = (append) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  const resultPromise = main(
    ["discover", "--root", emptyRoot],
    {
      stdin,
      stdout: sink((value) => (stdout += value)),
      stderr: sink((value) => (stderr += value)),
    },
  );
  stdin.write("1\n");
  setTimeout(() => stdin.write(`${skill}\n`), 20);
  const code = await resultPromise;
  stdin.end();
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.selection.name, "custom-review");
  assert.equal(
    result.selection.evidence.at(-1).confirmationEvidence.method,
    "interactive-cli-custom-path",
  );
});
