import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateLocalIdentity,
  normalizeRepositoryLocator,
  normalizeRepositoryUrl,
  normalizeUpstreamEntrypoint,
} from "../src/normalization.js";
import { fingerprintFile, fingerprintPath } from "../src/fingerprint.js";

test("repository normalization canonicalizes HTTPS, SSH, and GitHub tree URLs", () => {
  assert.equal(
    normalizeRepositoryUrl("git@github.com:Example/Skills.git"),
    "https://github.com/Example/Skills",
  );
  assert.equal(
    normalizeRepositoryUrl("ssh://git@github.com/Example/Skills.git"),
    "https://github.com/Example/Skills",
  );
  assert.deepEqual(
    normalizeRepositoryLocator(
      "https://github.com/Example/Skills/tree/main/skills/review",
    ),
    {
      repository: "https://github.com/Example/Skills",
      revision: "main",
      subdir: "skills/review",
    },
  );
});

test("upstream entrypoint normalization is shared across discovery and bindings", () => {
  assert.equal(
    normalizeUpstreamEntrypoint(".\\skills\\review\\skill.md"),
    "skills/review/SKILL.md",
  );
  assert.equal(
    normalizeUpstreamEntrypoint("./skills/review/"),
    "skills/review/SKILL.md",
  );
  assert.equal(normalizeUpstreamEntrypoint("."), "SKILL.md");
  assert.equal(normalizeUpstreamEntrypoint(""), undefined);
});

test("local identities are opaque and deterministic", () => {
  const identity = generateLocalIdentity({
    skillName: "review",
    fingerprint:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(
    identity,
    "local:sha256:d7abb7bb4dc66e78a63ca6bf0d56960107b5106ceb5f2caef1090cfb498128db",
  );
  assert.equal(identity.includes("/Users/"), false);
});

test("fingerprints exact file bytes and directory trees deterministically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fingerprint-"));
  await writeFile(path.join(root, "b.txt"), "world\n");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "a.txt"), "hello\n");
  assert.equal(
    await fingerprintFile(path.join(root, "nested", "a.txt")),
    "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  );
  const first = await fingerprintPath(root);
  const second = await fingerprintPath(root);
  assert.equal(first, second);
  await writeFile(path.join(root, "b.txt"), "changed\n");
  assert.notEqual(await fingerprintPath(root), first);
});
