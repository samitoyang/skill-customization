import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverAmbientSkills,
  discoverFixtureSkills,
} from "./support/discovery-modes.js";

async function writeSkill(root, name) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\nUse it.\n`,
  );
  return directory;
}

test("fixture discovery requires declared roots and manager records", async () => {
  await assert.rejects(
    discoverFixtureSkills({ roots: [] }),
    /managerRecords must be an explicit array/,
  );
  await assert.rejects(
    discoverFixtureSkills({ managerRecords: [] }),
    /roots must be an explicit array/,
  );
});

test("fixture discovery cannot invoke ambient plugin or manager inventory", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "fixture-discovery-mode-"));
  const skillsRoot = path.join(temporary, "skills");
  const source = await writeSkill(skillsRoot, "review");
  const unexpected = async () => assert.fail("ambient inventory was consulted");

  const result = await discoverFixtureSkills({
    input: "review",
    roots: [{ path: skillsRoot, owner: "fixture", scope: "custom" }],
    managerRecords: [],
    pluginDiscovery: unexpected,
    managerCollector: unexpected,
  });

  assert.equal(result.groups[0].copies[0].path, source);
  assert.deepEqual(
    result.searchedRoots.map(({ path: rootPath }) => rootPath),
    [skillsRoot],
  );
});

test("ambient discovery is an explicit isolated opt-in", async () => {
  await assert.rejects(
    discoverAmbientSkills({ managerRecords: [] }),
    /home, cwd, and env must be explicit/,
  );
  await assert.rejects(
    discoverAmbientSkills({
      home: undefined,
      cwd: "/fixture/workspace",
      env: {},
      managerRecords: [],
    }),
    /home, cwd, and env must be explicit/,
  );
  await assert.rejects(
    discoverAmbientSkills({
      home: "/fixture/home",
      cwd: "/fixture/workspace",
      env: {},
      roots: [],
      managerRecords: [],
    }),
    /does not accept explicit roots/,
  );
  await assert.rejects(
    discoverAmbientSkills({
      home: "/fixture/home",
      cwd: "/fixture/workspace",
      env: {},
      managerRecords: [],
      includePlugins: false,
    }),
    /cannot disable plugin discovery/,
  );

  const temporary = await mkdtemp(path.join(os.tmpdir(), "ambient-discovery-mode-"));
  const home = path.join(temporary, "home");
  const cwd = path.join(temporary, "workspace");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeSkill(path.join(home, ".codex", "skills"), "review");

  const result = await discoverAmbientSkills({
    input: "review",
    home,
    cwd,
    env: { CODEX_HOME: path.join(home, ".codex") },
    managerRecords: [],
    pluginDiscovery: async () => ({ roots: [], diagnostics: [] }),
  });

  assert.equal(result.groups[0].copies[0].owner, "codex");
  assert.ok(
    result.searchedRoots.every(({ path: rootPath }) => rootPath.startsWith(temporary)),
  );
});
