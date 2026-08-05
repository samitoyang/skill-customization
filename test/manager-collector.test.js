import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverSkills } from "../src/discovery.js";
import {
  collectManagerRecords,
  defaultManagerSources,
  managerSkillRoots,
} from "../src/manager-collector.js";
import { classifyBindingScope } from "../src/bindings.js";

const fixture = async (name) =>
  readFile(new URL(`./fixtures/managers/${name}.json`, import.meta.url), "utf8");

test("collector combines manager files and JSON CLIs through one seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-collector-"));
  const lock = path.join(root, ".agents", ".skill-lock.json");
  const sourcesFile = path.join(root, "library", "sources.json");
  await mkdir(path.dirname(lock), { recursive: true });
  await mkdir(path.dirname(sourcesFile), { recursive: true });
  await writeFile(lock, await fixture("vercel-v3"));
  await writeFile(sourcesFile, await fixture("jtianling-sources"));
  const outputs = {
    asm: await fixture("asm-list"),
    "skills-manager": await fixture("xing-list"),
  };
  const collected = await collectManagerRecords({
    home: root,
    cwd: root,
    env: { PATH: "/fixture/bin" },
    sources: {
      vercelLocks: [lock],
      jtianlingSources: [sourcesFile],
      xingDatabases: [],
    },
    commandAvailable: async () => true,
    run: async (command) => ({ stdout: outputs[command] }),
  });
  const managers = new Set(collected.records.map(({ manager }) => manager));
  assert.deepEqual([...managers].sort(), ["asm", "jtianling", "vercel", "xing"]);
  assert.ok(collected.records.some(({ path: recordPath }) => recordPath === null));
  assert.ok(collected.diagnostics.every(({ status }) => status === "read"));
});

test("discovery scans manager-owned paths but null-path provenance cannot satisfy a local source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-discovery-"));
  const installed = path.join(root, "manager-library", "review");
  await mkdir(installed, { recursive: true });
  await writeFile(
    path.join(installed, "SKILL.md"),
    "---\nname: review\ndescription: fixture\n---\nUse it.\n",
  );
  const repository = "https://github.com/example/skills";
  const localRecord = {
    manager: "asm",
    name: "review",
    path: installed,
    scope: "global",
    source: { kind: "repository", repository },
  };
  const found = await discoverSkills({
    input: repository,
    roots: [],
    managerCollector: async () => ({ records: [localRecord], diagnostics: [] }),
  });
  assert.equal(found.groups[0].copies[0].owner, "manager:asm");

  const metadataOnly = { ...localRecord, path: null };
  await assert.rejects(
    discoverSkills({
      input: repository,
      roots: [],
      managerCollector: async () => ({ records: [metadataOnly], diagnostics: [] }),
    }),
    (error) =>
      error.code === "NO_LOCAL_COPY" && error.details.metadataMatches.length === 1,
  );
});

test("manager roots drive binding scope and workspace locks include bounded ancestors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-roots-"));
  const repository = path.join(root, "repo");
  const nested = path.join(repository, "packages", "app");
  const installed = path.join(root, "manager-library", "review");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(installed, { recursive: true });
  const managerRoots = managerSkillRoots([
    {
      manager: "asm",
      path: installed,
      scope: "global",
    },
  ]);
  assert.equal(
    (await classifyBindingScope({ sourcePath: installed, roots: managerRoots })).scope,
    "global",
  );
  const sources = defaultManagerSources({ home: root, cwd: nested, env: {} });
  assert.ok(
    sources.vercelLocks.includes(
      path.join(repository, ".agents", ".skill-lock.json"),
    ),
  );
});
