import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeSkillInventory,
  confirmDiscoverySelection,
  configuredHostSkillRoots,
  createDiscoverySnapshot,
  hostSkillRoots,
} from "../src/discovery.js";
import { fingerprintPath } from "../src/fingerprint.js";
import { discoverFixtureSkills } from "./support/discovery-modes.js";

async function writeSkill(root, folder, name = folder, body = "Use this skill.\n") {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\n${body}`,
  );
  return directory;
}

test("fixture discovery keeps plugin roots disabled and explicit roots authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-plugin-policy-"));
  const home = path.join(root, "home");
  await writeSkill(
    path.join(home, ".claude", "plugins", "cache", "official", "reviewer", "1", "skills"),
    "review",
  );

  const disabled = await discoverFixtureSkills({
    roots: [],
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    includePlugins: false,
    managerRecords: [],
  });
  assert.equal(disabled.groups.length, 0);
  assert.equal(disabled.searchedRoots.some(({ owner }) => owner.startsWith("plugin:")), false);

  const explicit = await discoverFixtureSkills({
    roots: [],
    additionalRoots: [path.join(home, ".claude", "plugins")],
    home,
    cwd: path.join(root, "workspace"),
    env: {},
    managerRecords: [],
  });
  assert.equal(explicit.groups.length, 0);
  assert.equal(explicit.searchedRoots.length, 0);
});

test("discovery fingerprints exclude the request state store inside a source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-state-fingerprint-"));
  const source = await writeSkill(root, "review", "review");
  const statePath = path.join(source, ".state", "bindings.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, "first state\n");

  const options = {
    roots: [{ path: root, scope: "global", origin: "personal" }],
    managerRecords: [],
    statePath,
  };
  const first = await discoverFixtureSkills(options);
  const expected = await fingerprintPath(source, { excludedPaths: [statePath] });
  assert.equal(first.groups[0].fingerprint, expected);

  await writeFile(statePath, "changed state\n");
  const second = await discoverFixtureSkills(options);
  assert.equal(second.groups[0].fingerprint, expected);
});

test("discovery snapshots seed inventory and memoize targeted lookups per operation", async () => {
  const seeded = { groups: [], searchedRoots: [{ path: "/seeded" }] };
  const targeted = { groups: [], searchedRoots: [{ path: "/targeted" }] };
  let calls = 0;
  const discover = async ({ input, roots }) => {
    calls += 1;
    assert.deepEqual(roots, [{ path: "/seeded" }]);
    return input === "outside" ? targeted : seeded;
  };
  const snapshot = createDiscoverySnapshot({
    discovery: seeded,
    discover,
  });

  assert.equal(await snapshot.inventory(), seeded);
  assert.equal(await snapshot.inventory(), seeded);
  assert.equal(await snapshot.discover({ input: "outside" }), targeted);
  assert.equal(await snapshot.discover({ input: "outside" }), targeted);
  assert.equal(calls, 1);

  const nextOperation = createDiscoverySnapshot({
    roots: [{ path: "/seeded" }],
    discover,
  });
  assert.equal(await nextOperation.inventory(), seeded);
  assert.equal(calls, 2);
});

test("ambient discovery snapshots refresh without freezing observed plugin roots", async () => {
  const seeded = {
    groups: [],
    rootsAreExplicit: false,
    searchedRoots: [{ path: "/observed-plugin-cache" }],
  };
  let refreshed = 0;
  const snapshot = createDiscoverySnapshot({
    discovery: seeded,
    discover: async ({ roots }) => {
      refreshed += 1;
      assert.equal(roots, undefined);
      return seeded;
    },
  });
  assert.equal(await snapshot.inventory(), seeded);
  await snapshot.discover({ input: "review" });
  assert.equal(refreshed, 1);
});

test("discovery snapshot revision records an expected targeted miss", async () => {
  const snapshot = createDiscoverySnapshot({
    discovery: { groups: [], searchedRoots: [] },
    discover: async ({ input }) => {
      if (input === "missing") {
        const error = new Error("no local copy");
        error.code = "NO_LOCAL_COPY";
        throw error;
      }
      return { groups: [], searchedRoots: [] };
    },
  });

  await assert.rejects(
    snapshot.discover({ input: "missing" }),
    (error) => error.code === "NO_LOCAL_COPY",
  );
  assert.equal(typeof await snapshot.revision(), "string");
});

test("discovery normalizes standard, plugin, and manager roots through one registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-root-registry-sources-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const pluginInstall = path.join(root, "plugin");
  const pluginSkills = path.join(pluginInstall, "skills");
  const standardAlias = path.join(workspace, ".agents", "skills");
  const managerAlias = path.join(root, "manager", "skills");
  await writeSkill(pluginSkills, "review");
  await mkdir(path.dirname(standardAlias), { recursive: true });
  await symlink(pluginSkills, standardAlias, "dir");
  await mkdir(path.dirname(managerAlias), { recursive: true });
  await symlink(pluginSkills, managerAlias, "dir");

  const pluginIdentity = "local:plugin:fixture:official:reviewer";
  const result = await discoverFixtureSkills({
    roots: [
      {
        kind: "standard",
        path: standardAlias,
        owner: "agents",
        scope: "workspace",
        origin: "project",
      },
      {
        kind: "plugin",
        path: pluginSkills,
        owner: "plugin:fixture",
        scope: "global",
        origin: "plugin",
        active: false,
        plugin: { host: "fixture", marketplace: "official", name: "reviewer" },
        pluginIdentity,
        pluginEvidence: [{
          kind: "plugin",
          host: "fixture",
          plugin: "reviewer",
          marketplace: "official",
          identity: pluginIdentity,
          provenance: {
            kind: "plugin",
            host: "fixture",
            plugin: "reviewer",
            marketplace: "official",
          },
        }],
        pluginRoot: pluginInstall,
      },
    ],
    home,
    cwd: workspace,
    env: {},
    managerRecords: [{
      manager: "asm",
      name: "review",
      path: managerAlias,
      scope: "workspace",
      source: { kind: "local" },
    }],
  });

  const physical = await realpath(pluginSkills);
  const matchingRoots = result.searchedRoots.filter(
    ({ physicalPath }) => physicalPath === physical,
  );
  assert.equal(matchingRoots.length, 1);
  const [rootRecord] = matchingRoots;
  assert.equal(rootRecord.path, standardAlias);
  assert.equal(rootRecord.owner, "agents");
  assert.deepEqual(
    rootRecord.owners.filter((owner) =>
      ["agents", "plugin:fixture", "manager:asm"].includes(owner),
    ).sort(),
    ["agents", "manager:asm", "plugin:fixture"],
  );
  assert.equal(rootRecord.origin, "plugin");
  assert.equal(rootRecord.pluginIdentity, pluginIdentity);
  assert.equal(rootRecord.active, true);

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].copies.length, 1);
  assert.deepEqual(result.groups[0].copies[0].owners, rootRecord.owners);
  assert.deepEqual(result.groups[0].provenance, [pluginIdentity]);
  assert.equal(
    result.groups[0].evidence.some(({ kind }) => kind === "manager"),
    true,
  );
});





test("discovery retains root-level registry diagnostics", async () => {
  const rootDiagnostic = {
    code: "INVALID_ROOT_PATH",
    message: "skill root observation requires a non-empty path",
    observationIndex: 0,
  };
  const result = await discoverFixtureSkills({
    roots: [],
    managerRecords: [],
    rootDiagnostics: [rootDiagnostic],
  });
  assert.deepEqual(result.rootDiagnostics, [rootDiagnostic]);
});





test("discovery groups equivalent copies and exposes every path and owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-"));
  const codexRoot = path.join(root, ".codex", "skills");
  const copilotRoot = path.join(root, ".copilot", "skills");
  await writeSkill(codexRoot, "review");
  await writeSkill(copilotRoot, "review");
  await writeSkill(path.join(root, "unbounded"), "secret");

  const result = await discoverFixtureSkills({
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





test("discovery isolates an invalid sibling candidate and reports its diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-invalid-sibling-"));
  await writeSkill(root, "review");
  const invalid = await writeSkill(root, "invalid");
  await symlink(path.join(invalid, "SKILL.md"), path.join(invalid, "LINK.md"));

  const result = await discoverFixtureSkills({
    input: "review",
    roots: [{ path: root, owner: "codex", scope: "global" }],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, "review");
  assert.deepEqual(result.candidateDiagnostics, [
    {
      path: invalid,
      code: "FINGERPRINT_SYMLINK",
      message: "directory fingerprint contains a symbolic link: LINK.md",
    },
  ]);
});





test("discovery isolates malformed embedded metadata in a sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-malformed-sibling-"));
  await writeSkill(root, "review");
  const malformed = await writeSkill(root, "malformed");
  await writeFile(path.join(malformed, ".skill-source.json"), "{not-json\n");

  const result = await discoverFixtureSkills({
    input: "review",
    roots: [{ path: root, owner: "codex", scope: "global" }],
    managerRecords: [],
  });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].name, "review");
  assert.equal(result.candidateDiagnostics.length, 1);
  assert.equal(result.candidateDiagnostics[0].path, malformed);
  assert.equal(
    result.candidateDiagnostics[0].code,
    "MALFORMED_SOURCE_METADATA",
  );
  await assert.rejects(
    discoverFixtureSkills({
      input: malformed,
      roots: [{ path: root, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "MALFORMED_SOURCE_METADATA",
  );
});





test("an explicit invalid alias preserves its specific candidate error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discover-invalid-alias-"));
  const invalid = await writeSkill(root, "invalid");
  const alias = path.join(root, "installed-invalid");
  await symlink(path.join(invalid, "SKILL.md"), path.join(invalid, "LINK.md"));
  await symlink(invalid, alias);

  await assert.rejects(
    discoverFixtureSkills({
      input: alias,
      roots: [{ path: invalid, owner: "codex", scope: "global" }],
      managerRecords: [],
    }),
    (error) => error.code === "FINGERPRINT_SYMLINK",
  );
});





test("discovery scans an aliased physical root once and retains associated owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "physical-root-"));
  const physical = path.join(root, "physical");
  const firstAlias = path.join(root, "first-alias");
  const secondAlias = path.join(root, "second-alias");
  await writeSkill(physical, "review");
  await symlink(physical, firstAlias, "dir");
  await symlink(physical, secondAlias, "dir");

  const result = await discoverFixtureSkills({
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

  const result = await discoverFixtureSkills({
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
  const result = await discoverFixtureSkills({
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
  const result = await discoverFixtureSkills({
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
  const result = await discoverFixtureSkills({
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
    discoverFixtureSkills({
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
  const byPath = await discoverFixtureSkills({
    input: relative,
    roots: [{ path: skillsRoot, owner: "workspace", scope: "workspace" }],
    managerRecords: [],
  });
  assert.equal(byPath.groups[0].name, "a");
  const bySubdir = await discoverFixtureSkills({
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

  const result = await discoverFixtureSkills({
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
    discoverFixtureSkills({
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
  const discovery = await discoverFixtureSkills({
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
  const discovery = await discoverFixtureSkills({
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
  const discovery = await discoverFixtureSkills({
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
          {
            path: "/cache/review",
            realPath: "/cache/review",
            owner: "plugin:codex",
            active: false,
          },
          {
            path: "/alias/review",
            realPath: "/source/review",
            owner: "plugin:codex",
            active: false,
          },
          { path: "/source/review", realPath: "/source/review", owner: "manager:asm" },
        ],
      },
    ],
  });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].realPath, "/source/review");
});





test("adjacent customization metadata is classified and malformed metadata is visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discovery-customization-metadata-"));
  const malformed = await writeSkill(root, "managed-overlay");
  await writeFile(path.join(malformed, "customization.json"), "{not-json\n");
  await assert.rejects(
    discoverFixtureSkills({ input: malformed, roots: [], managerRecords: [] }),
    (error) => error.code === "MALFORMED_CUSTOMIZATION_METADATA",
  );
});
