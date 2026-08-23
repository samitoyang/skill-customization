import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverAmbientSkills } from "./support/discovery-modes.js";
import { writeFixtureSkill } from "./support/discovery-fixture.js";

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
  for (const injectedRoot of [
    { roots: [] },
    { additionalRoots: [] },
    { customPath: "/fixture/skill" },
  ]) {
    await assert.rejects(
      discoverAmbientSkills({
        home: "/fixture/home",
        cwd: "/fixture/workspace",
        env: {},
        managerRecords: [],
        ...injectedRoot,
      }),
      /does not accept explicit roots/,
    );
  }
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
  await writeFixtureSkill(path.join(home, ".codex", "skills"), "review");

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
