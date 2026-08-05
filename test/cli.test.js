import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bindCustomization } from "../src/bindings.js";
import { fingerprintFile } from "../src/fingerprint.js";
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
  const fingerprint = await fingerprintFile(path.join(source, "SKILL.md"));
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-local-archive",
    type: "semantic-overlay",
    name: "review-local-archive",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      review: { revision: "abc", fingerprint },
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

test("CLI accepts standard top-level help flags", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await run([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
  }
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

test("CLI rejects unknown long options for every command", async (t) => {
  const commandArguments = {
    validate: ["customization.json"],
    fingerprint: ["SKILL.md"],
    discover: ["review"],
    bind: ["customization.json"],
    resolve: ["customization.json"],
    reconcile: ["customization.json"],
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
    validate: ["customization.json", "extra"],
    fingerprint: ["SKILL.md", "extra"],
    discover: ["review", "extra"],
    bind: ["customization.json", "extra"],
    resolve: ["customization.json", "extra"],
    reconcile: ["customization.json", "extra"],
    help: ["extra"],
  };
  for (const [command, argumentsForCommand] of Object.entries(commandArguments)) {
    await t.test(command, async () => {
      const result = await run([command, ...argumentsForCommand]);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        new RegExp(`too many positional arguments for ${command}`, "i"),
      );
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
