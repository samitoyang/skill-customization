import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoveryPerformanceChannel } from "../src/performance-diagnostics.js";
import {
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

test("Git provenance is cached per repository and skipped for non-repository candidates", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "git-provenance-probe-"));
  const repositoryRoot = path.join(temporary, "repository");
  const repositorySkills = path.join(repositoryRoot, "skills");
  const nonRepositorySkills = path.join(temporary, "non-repository", "skills");
  const repository = "https://github.com/example/provenance";
  const review = await writeSkill(repositorySkills, "review");
  const planning = await writeSkill(repositorySkills, "planning");
  const standalone = await writeSkill(nonRepositorySkills, "standalone");

  assert.equal(spawnSync("git", ["init", "-q", repositoryRoot]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repositoryRoot, "remote", "add", "origin", repository]).status,
    0,
  );

  const metrics = {};
  const listener = ({ name, amount = 1 }) => {
    metrics[name] = (metrics[name] ?? 0) + amount;
  };
  discoveryPerformanceChannel.subscribe(listener);
  let result;
  try {
    result = await discoverFixtureSkills({
      roots: [
        { path: repositorySkills, owner: "repository", scope: "custom" },
        { path: nonRepositorySkills, owner: "fixture", scope: "custom" },
      ],
      managerRecords: [],
    });
  } finally {
    discoveryPerformanceChannel.unsubscribe(listener);
  }

  assert.equal(metrics.git_probes, 1);
  const groups = new Map(result.groups.map((group) => [group.name, group]));
  assert.deepEqual(groups.get("review").provenance, [
    `repository:${repository}#skills/review/SKILL.md`,
  ]);
  assert.deepEqual(groups.get("planning").provenance, [
    `repository:${repository}#skills/planning/SKILL.md`,
  ]);
  assert.deepEqual(groups.get("standalone").provenance, []);
  assert.equal(groups.get("review").copies[0].path, review);
  assert.equal(groups.get("planning").copies[0].path, planning);
  assert.equal(groups.get("standalone").copies[0].path, standalone);
});

test("Unavailable Git metadata remains fail-soft after a single repository probe", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "git-provenance-unavailable-"));
  const repositoryRoot = path.join(temporary, "repository");
  const skillsRoot = path.join(repositoryRoot, "skills");
  await writeSkill(skillsRoot, "review");

  assert.equal(spawnSync("git", ["init", "-q", repositoryRoot]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repositoryRoot, "config", "remote.origin.url", "not-a-repository"]).status,
    0,
  );

  const metrics = {};
  const listener = ({ name, amount = 1 }) => {
    metrics[name] = (metrics[name] ?? 0) + amount;
  };
  discoveryPerformanceChannel.subscribe(listener);
  let result;
  try {
    result = await discoverFixtureSkills({
      roots: [{ path: skillsRoot, owner: "repository", scope: "custom" }],
      managerRecords: [],
    });
  } finally {
    discoveryPerformanceChannel.unsubscribe(listener);
  }

  assert.equal(metrics.git_probes, 1);
  assert.deepEqual(result.groups[0].provenance, []);
  assert.deepEqual(result.groups[0].evidence, []);
  assert.deepEqual(result.candidateDiagnostics, []);
});
