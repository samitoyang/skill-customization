import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeSkillInventory,
  confirmDiscoverySelection,
  configuredHostSkillRoots,
  discoverSkills,
  hostSkillRoots,
} from "../src/discovery.js";

async function writeSkill(root, folder, name = folder, body = "Use this skill.\n") {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\n${body}`,
  );
  return directory;
}

test("host roots include Codex, Claude additions, and Copilot env without a home crawl", async () => {
  const home = "/fixture/home";
  const roots = hostSkillRoots({
    home,
    cwd: "/fixture/workspace/project",
    env: { COPILOT_SKILLS_DIRS: "/opt/team-skills:/opt/other-skills" },
    claudeSettings: { additionalDirectories: ["/opt/claude-project"] },
  });
  const paths = roots.map((root) => root.path);
  assert.ok(paths.includes("/fixture/home/.codex/skills"));
  assert.ok(paths.includes("/fixture/home/.claude/skills"));
  assert.ok(paths.includes("/fixture/home/.copilot/skills"));
  assert.ok(paths.includes("/opt/team-skills"));
  assert.ok(paths.includes("/opt/claude-project/.claude/skills"));
  assert.equal(paths.some((value) => value === home), false);
});

test("host roots include bounded Git ancestors as workspace roots", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "host-roots-"));
  const repository = path.join(base, "repository");
  const nested = path.join(repository, "packages", "app");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  const roots = hostSkillRoots({ home: base, cwd: nested, env: {} });
  assert.ok(
    roots.some(
      (item) =>
        item.path === path.join(repository, ".codex", "skills") &&
        item.scope === "workspace" &&
        item.origin === "ancestor",
    ),
  );
  assert.ok(
    roots.some(
      (item) =>
        item.path === path.join(repository, ".agents", "skills") &&
        item.origin === "ancestor",
    ),
  );
  assert.equal(roots.some(({ path: rootPath }) => rootPath === base), false);
});

test("configured host roots load bounded global and workspace Claude settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-settings-"));
  const home = path.join(root, "home");
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "packages", "app");
  const directSkills = path.join(root, "direct", "skills");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(repository, ".claude"), { recursive: true });
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ additionalDirectories: ["~/shared"] }),
  );
  await writeFile(
    path.join(repository, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { additionalDirectories: ["../team", directSkills] },
    }),
  );

  const configured = await configuredHostSkillRoots({ home, cwd: nested, env: {} });
  const paths = configured.roots.map(({ path: rootPath }) => rootPath);
  assert.ok(paths.includes(path.join(home, "shared", ".claude", "skills")));
  assert.ok(paths.includes(path.join(root, "team", ".claude", "skills")));
  assert.ok(paths.includes(directSkills));
  assert.equal(configured.settingsEvidence.length, 3);
  assert.deepEqual(configured.diagnostics, []);
  assert.equal(paths.some((rootPath) => rootPath === root), false);
});

test("discovery groups equivalent copies and exposes every path and owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-"));
  const codexRoot = path.join(root, ".codex", "skills");
  const copilotRoot = path.join(root, ".copilot", "skills");
  await writeSkill(codexRoot, "review");
  await writeSkill(copilotRoot, "review");
  await writeSkill(path.join(root, "unbounded"), "secret");

  const result = await discoverSkills({
    input: "review",
    roots: [
      { path: codexRoot, owner: "codex", scope: "global" },
      { path: copilotRoot, owner: "copilot", scope: "global" },
    ],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 2);
  assert.deepEqual(
    result.groups[0].copies.map(({ owner }) => owner).sort(),
    ["codex", "copilot"],
  );
  assert.equal(result.groups.some(({ name }) => name === "secret"), false);
  assert.deepEqual(result.choices.at(-1), { kind: "custom-path" });
});

test("discovery scans an aliased physical root once and retains associated owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "physical-root-"));
  const physical = path.join(root, "physical");
  const firstAlias = path.join(root, "first-alias");
  const secondAlias = path.join(root, "second-alias");
  await writeSkill(physical, "review");
  await symlink(physical, firstAlias, "dir");
  await symlink(physical, secondAlias, "dir");

  const result = await discoverSkills({
    input: "review",
    roots: [
      { path: firstAlias, owner: "codex", scope: "global" },
      { path: secondAlias, owner: "cursor", scope: "global" },
    ],
    managerRecords: [],
  });

  assert.equal(result.searchedRoots.length, 1);
  assert.equal(result.groups[0].copies.length, 1);
  assert.deepEqual(result.groups[0].copies[0].owners, ["codex", "cursor"]);
  assert.deepEqual(result.searchedRoots[0].aliases.sort(), [firstAlias, secondAlias]);
});

test("discovery orders explicit, Git, manager, and embedded evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evidence-"));
  const repository = path.join(root, "repo");
  const skillsRoot = path.join(repository, "skills");
  const skill = await writeSkill(skillsRoot, "review");
  await writeFile(
    path.join(skill, ".skill-source.json"),
    JSON.stringify({
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review",
    }),
  );
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repository, "remote", "add", "origin", "git@github.com:example/skills.git"]).status,
    0,
  );

  const result = await discoverSkills({
    input: skill,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: {
          kind: "repository",
          repository: "https://github.com/example/skills",
          upstreamPath: "skills/review",
        },
      },
    ],
  });
  assert.deepEqual(
    result.groups[0].evidence.map(({ kind }) => kind),
    ["explicit", "git", "manager", "embedded"],
  );
  assert.equal(result.groups[0].conflict, false);
});

test("discovery surfaces provenance conflicts instead of merging silently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conflict-"));
  const skillsRoot = path.join(root, "skills");
  const skill = await writeSkill(skillsRoot, "review");
  const result = await discoverSkills({
    input: "review",
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: { kind: "repository", repository: "https://github.com/a/one" },
      },
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: { kind: "repository", repository: "https://github.com/b/two" },
      },
    ],
  });
  assert.equal(result.groups[0].conflict, true);
  assert.equal(result.groups[0].provenance.length, 2);
});

test("manager owners and non-repository provenance remain visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manager-provenance-"));
  const skill = await writeSkill(root, "review");
  const result = await discoverSkills({
    input: "review",
    roots: [],
    managerRecords: [
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: { kind: "local" },
        provenance: { kind: "registry", reference: "registry:review@1" },
      },
      {
        manager: "jtianling",
        name: "review",
        path: skill,
        source: { kind: "local" },
        provenance: { kind: "archive", reference: "https://example.test/review.zip" },
      },
    ],
  });

  assert.equal(result.groups[0].copies.length, 1);
  assert.equal(result.groups[0].copies[0].owner, "manager:xing");
  assert.deepEqual(
    result.groups[0].copies[0].owners.sort(),
    ["manager:jtianling", "manager:xing"],
  );
  assert.equal(result.groups[0].provenance.length, 2);
  assert.equal(result.groups[0].conflict, true);
  assert.ok(result.groups[0].evidence.every(({ provenance }) => provenance));
});

test("canonical upstream entrypoints participate in provenance conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstream-conflict-"));
  const skill = await writeSkill(root, "review");
  const repository = "https://github.com/example/skills";
  const result = await discoverSkills({
    input: "review",
    roots: [],
    managerRecords: [
      {
        manager: "asm",
        name: "review",
        path: skill,
        source: { kind: "repository", repository, upstreamPath: "skills/review" },
      },
      {
        manager: "xing",
        name: "review",
        path: skill,
        source: {
          kind: "repository",
          repository,
          upstream_path: "skills/other/SKILL.md",
        },
      },
    ],
  });

  assert.equal(result.groups[0].conflict, true);
  assert.deepEqual(
    result.groups[0].evidence.map(({ upstream_path }) => upstream_path).sort(),
    ["skills/other/SKILL.md", "skills/review/SKILL.md"],
  );
  assert.ok(result.groups[0].provenance.every((value) => value.includes("#skills/")));
});

test("repository discovery blocks when no local copy exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "missing-"));
  await assert.rejects(
    discoverSkills({
      input: "https://github.com/example/missing/tree/main/skills/review",
      roots: [{ path: root, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "NO_LOCAL_COPY",
  );
});

test("existing relative paths win over repository slugs and repository subdirs select exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "locator-"));
  const repository = path.join(root, "repo");
  const skillsRoot = path.join(repository, "skills");
  const first = await writeSkill(skillsRoot, "a");
  await writeSkill(skillsRoot, "b");
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(
    spawnSync("git", ["-C", repository, "remote", "add", "origin", "https://github.com/example/skills"]).status,
    0,
  );
  const relative = path.relative(process.cwd(), first);
  const byPath = await discoverSkills({
    input: relative,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });
  assert.equal(byPath.groups[0].name, "a");
  const bySubdir = await discoverSkills({
    input: "https://github.com/example/skills/tree/main/skills/a",
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });
  assert.deepEqual(bySubdir.groups.map(({ name }) => name), ["a"]);
});

test("an explicit skill nested below a configured root is always considered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-input-"));
  const skillsRoot = path.join(root, "skills");
  const nested = await writeSkill(path.join(skillsRoot, "team", "productivity"), "review");

  const result = await discoverSkills({
    input: nested,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies[0].path, nested);
  assert.equal(result.groups[0].evidence[0].kind, "explicit");
});

test("an existing relative filesystem path wins over repository-slug parsing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "path-or-slug-"));
  const existingPath = path.join(root, "team", "review");
  const library = path.join(root, "library");
  const installed = await writeSkill(library, "review");
  await mkdir(existingPath, { recursive: true });

  await assert.rejects(
    discoverSkills({
      input: "team/review",
      cwd: root,
      roots: [{ path: library, owner: "manager:asm", scope: "global" }],
      managerRecords: [
        {
          manager: "asm",
          name: "review",
          path: installed,
          source: {
            kind: "repository",
            repository: "https://github.com/team/review",
          },
        },
      ],
    }),
    (error) => error.code === "NO_LOCAL_COPY",
  );
});

test("confirmation is explicit, interactive, and last in the evidence order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "confirmation-"));
  const skill = await writeSkill(root, "review");
  const discovery = await discoverSkills({
    input: skill,
    roots: [{ path: root, owner: "custom", scope: "custom" }],
    managerRecords: [],
  });
  const choice = {
    name: discovery.groups[0].name,
    fingerprint: discovery.groups[0].fingerprint,
    path: discovery.groups[0].copies[0].path,
    owner: discovery.groups[0].copies[0].owner,
  };
  assert.throws(
    () => confirmDiscoverySelection({ discovery, choice, interactive: false }),
    (error) => error.code === "DISCOVERY_CONFIRMATION_REQUIRED",
  );
  const selected = confirmDiscoverySelection({ discovery, choice, interactive: true });
  assert.equal(selected.evidence.at(-1).kind, "confirmation");
});

test("confirmation can retain caller-provided audit evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "confirmation-audit-"));
  const skill = await writeSkill(root, "review");
  const discovery = await discoverSkills({
    input: skill,
    roots: [{ path: root, owner: "custom", scope: "custom" }],
    managerRecords: [],
  });
  const group = discovery.groups[0];
  const audit = {
    actor: "human",
    reason: "confirmed this unmanaged local source",
    at: "2026-08-04T00:00:00.000Z",
  };

  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: group.copies[0].path,
      owner: group.copies[0].owner,
    },
    interactive: true,
    confirmationEvidence: audit,
  });

  assert.deepEqual(selected.evidence.at(-1).confirmationEvidence, audit);
});

test("confirmation identifies groups by name plus fingerprint", () => {
  const shared = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const discovery = {
    groups: ["first", "second"].map((name) => ({
      name,
      fingerprint: shared,
      copies: [{
        path: `/${name}`,
        owner: "fixture",
        evidence: [],
        provenance: [],
        conflict: false,
      }],
      evidence: [],
      provenance: [],
      conflict: false,
    })),
  };
  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: "second",
      fingerprint: shared,
      path: "/second",
      owner: "fixture",
    },
    interactive: true,
  });
  assert.equal(selected.name, "second");
});

test("confirmation cannot pair one physical copy with another copy's provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copy-provenance-"));
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const first = await writeSkill(firstRoot, "review");
  await writeSkill(secondRoot, "review");
  const { spawnSync } = await import("node:child_process");
  for (const [repository, remote] of [
    [firstRoot, "https://github.com/example/first"],
    [secondRoot, "https://github.com/example/second"],
  ]) {
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    assert.equal(
      spawnSync("git", ["-C", repository, "remote", "add", "origin", remote]).status,
      0,
    );
  }
  const discovery = await discoverSkills({
    input: "review",
    roots: [
      { path: firstRoot, owner: "first", scope: "global" },
      { path: secondRoot, owner: "second", scope: "global" },
    ],
    managerRecords: [],
  });
  const group = discovery.groups[0];
  const firstCopy = group.copies.find(({ path: copyPath }) => copyPath === first);
  const otherProvenance = group.copies.find(({ owner }) => owner === "second")
    .provenance[0];

  assert.equal(group.conflict, true);
  assert.equal(firstCopy.conflict, false);
  assert.throws(
    () =>
      confirmDiscoverySelection({
        discovery,
        choice: {
          name: group.name,
          fingerprint: group.fingerprint,
          path: firstCopy.path,
          owner: firstCopy.owner,
        },
        interactive: true,
        confirmedProvenance: otherProvenance,
      }),
    (error) => error.code === "PROVENANCE_COPY_MISMATCH",
  );
  const selected = confirmDiscoverySelection({
    discovery,
    choice: {
      name: group.name,
      fingerprint: group.fingerprint,
      path: firstCopy.path,
      owner: firstCopy.owner,
    },
    interactive: true,
  });
  assert.equal(selected.provenance, firstCopy.provenance[0]);
});

test("active inventory deduplicates one physical source with multiple owners", () => {
  const inventory = activeSkillInventory({
    groups: [
      {
        name: "review",
        copies: [
          { path: "/alias/review", realPath: "/source/review", owner: "codex" },
          { path: "/source/review", realPath: "/source/review", owner: "manager:asm" },
        ],
      },
    ],
  });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].realPath, "/source/review");
});
