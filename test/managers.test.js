import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeAsmList,
  normalizeJtianlingSources,
  normalizeVercelLock,
  normalizeXingCli,
  parseAsmJson,
  parseJtianlingSources,
  parseVercelV3Lock,
  parseXingJson,
  readXingSqlite,
} from "../src/managers.js";

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/managers/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("Vercel v3 lock records retain their explicit source and checkpoint", async () => {
  const records = parseVercelV3Lock(await fixture("vercel-v3"), {
    lockPath: "/fixture/.agents/.skill-lock.json",
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    name: "review",
    path: "/fixture/.agents/skills/review",
    scope: "global",
    manager: "vercel",
    owner: { kind: "manager", manager: "vercel" },
    source: {
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review",
    },
    evidence: {
      kind: "manager-metadata",
      manager: "vercel",
      source: "example/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/example/skills.git",
      skillPath: "skills/review/SKILL.md",
    },
    provenance: {
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review",
      fingerprint: "sha-review",
    },
  });
  assert.deepEqual(records[1].source, { kind: "local" });
  assert.equal(records[1].path, "/srv/private-skill");
  assert.equal(normalizeVercelLock, parseVercelV3Lock);
});

test("Vercel adapter rejects every lock version except exactly v3", () => {
  assert.throws(
    () => parseVercelV3Lock({ version: 2, skills: {} }),
    /version 3/i,
  );
  assert.throws(
    () => parseVercelV3Lock({ version: "3", skills: {} }),
    /version 3/i,
  );
});

test("ASM list JSON preserves every installed copy and only explicit provenance", async () => {
  const records = parseAsmJson(await fixture("asm-list"));

  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map(({ name, path, scope }) => ({ name, path, scope })),
    [
      { name: "review", path: "/home/me/.codex/skills/review", scope: "global" },
      { name: "review", path: "/work/app/.agents/skills/review", scope: "workspace" },
      { name: "deploy", path: "/home/me/.claude/skills/deploy", scope: "global" },
    ],
  );
  assert.deepEqual(records[0].source, { kind: "local" });
  assert.deepEqual(records[2].source, {
    kind: "repository",
    repository: "https://github.com/example/skills",
    upstreamPath: "skills/deploy",
    revision: "abc123",
  });
  assert.equal(records[0].evidence.provider, "codex");
  assert.equal(normalizeAsmList, parseAsmJson);
});

test("ASM accepts common array and object envelopes", () => {
  const row = { name: "one", path: "/skills/one", scope: "global" };
  for (const value of [
    [row],
    { skills: [row] },
    { items: [row] },
    { data: [row] },
    { data: { skills: [row] } },
  ]) {
    assert.equal(parseAsmJson(value)[0].name, "one");
  }
});

test("xing CLI JSON retains central paths and explicit git checkpoints", async () => {
  const records = parseXingJson(await fixture("xing-list"));

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].source, {
    kind: "repository",
    repository: "https://git.example.test/team/skills",
    upstreamPath: "skills/review",
    revision: "abc123",
  });
  assert.equal(records[0].path, "/library/review");
  assert.equal(records[0].provenance.fingerprint, "hash-review");
  assert.deepEqual(records[1].source, { kind: "local" });
  assert.equal(records[1].provenance.reference, "/work/private-helper");
  assert.equal(normalizeXingCli, parseXingJson);
});

test("xing CLI accepts list, full DTO, and JSON envelope variants", () => {
  const row = {
    name: "one",
    path: "/library/one",
    source_type: "local",
  };
  for (const value of [
    [row],
    { skills: [row] },
    { records: [row] },
    { data: [row] },
    { data: { items: [row] } },
  ]) {
    assert.equal(parseXingJson(value)[0].name, "one");
  }
});

test("xing SQLite fallback reads only the confirmed v7 schema", async () => {
  const calls = [];
  const requiredColumns = [
    "name",
    "central_path",
    "source_type",
    "source_ref",
    "source_ref_resolved",
    "source_subpath",
    "source_branch",
    "source_revision",
    "content_hash",
    "enabled",
  ];
  const run = async (dbPath, sql) => {
    calls.push({ dbPath, sql });
    if (/PRAGMA user_version/i.test(sql)) return [{ user_version: 7 }];
    if (/PRAGMA table_info\(skills\)/i.test(sql)) {
      return requiredColumns.map((name, cid) => ({ cid, name }));
    }
    return [
      {
        name: "review",
        central_path: "/library/review",
        source_type: "git",
        source_ref: "https://github.com/example/skills.git",
        source_ref_resolved: null,
        source_subpath: "skills/review",
        source_branch: "main",
        source_revision: "abc123",
        content_hash: "hash-review",
        enabled: 0,
      },
    ];
  };

  const records = await readXingSqlite("/state/skills.db", { run });

  assert.equal(records[0].name, "review");
  assert.equal(records[0].enabled, false);
  assert.equal(records[0].source.repository, "https://github.com/example/skills");
  assert.equal(calls.length, 3);
  assert.match(calls[2].sql, /^SELECT name, central_path, source_type,/);
  assert.doesNotMatch(calls[2].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test("xing SQLite fallback rejects unknown versions and incomplete v7 schemas", async () => {
  await assert.rejects(
    readXingSqlite("/state/newer.db", {
      run: async () => JSON.stringify([{ user_version: 8 }]),
    }),
    /unsupported.*8/i,
  );

  let call = 0;
  await assert.rejects(
    readXingSqlite("/state/broken.db", {
      run: async () => {
        call += 1;
        return call === 1
          ? { stdout: '[{"user_version":7}]' }
          : [{ name: "name" }];
      },
    }),
    /schema.*central_path/i,
  );
});

test("jtianling sources combine git, registry, zip, and manager-local disk evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jtianling-manager-"));
  const skillPaths = [
    ["community/example/skills/review", "review"],
    ["registry/code-review", "code-review"],
    ["custom/archive-helper", "archive-helper"],
    ["custom/team/local-one", "local-one"],
    ["custom/untracked-local", "untracked-local"],
    ["unrelated/ignored", "ignored"],
  ];
  for (const [relative, name] of skillPaths) {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\n---\n# ${name}\n`,
    );
  }

  const records = parseJtianlingSources(await fixture("jtianling-sources"), {
    root,
  });
  const byName = new Map(records.map((record) => [record.name, record]));

  assert.equal(records.length, 5);
  assert.deepEqual(byName.get("review").source, {
    kind: "repository",
    repository: "https://github.com/example/skills",
  });
  assert.equal(byName.get("review").provenance.bundleType, "git");
  assert.deepEqual(byName.get("code-review").source, { kind: "local" });
  assert.equal(byName.get("code-review").provenance.kind, "registry");
  assert.equal(byName.get("archive-helper").provenance.kind, "archive");
  assert.deepEqual(byName.get("local-one").source, { kind: "local" });
  assert.equal(byName.get("untracked-local").provenance.kind, "local");
  assert.equal(byName.has("ignored"), false);
  assert.equal(normalizeJtianlingSources, parseJtianlingSources);
});

test("jtianling metadata without a local copy stays visible with a null path", async () => {
  const records = parseJtianlingSources(await fixture("jtianling-sources"));
  const repository = records.find(
    (record) => record.source.kind === "repository",
  );

  assert.ok(repository);
  assert.equal(repository.path, null);
  assert.equal(repository.name, "skills");
});

test("jtianling adapter rejects unknown schemas and conflicting bundle provenance", () => {
  assert.throws(
    () => parseJtianlingSources({ version: "4.0", sources: {}, bundles: {} }),
    /unsupported.*4\.0/i,
  );
  assert.throws(
    () =>
      parseJtianlingSources({
        version: "3.0",
        sources: {},
        bundles: {
          first: {
            type: "git",
            url: "https://github.com/one/skills",
            members: ["community/example/skills"],
          },
          second: {
            type: "zip",
            url: "https://example.test/skills.zip",
            members: ["community/example/skills"],
          },
        },
      }),
    /conflicting.*community\/example\/skills/i,
  );
});
