import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readDescriptor,
  validateDescriptor,
} from "../src/descriptor.js";
import { isMachineAbsolutePath } from "../src/paths.js";

const MACHINE_PATHS = [
  "/Users/alice/customization.schema.json",
  "\\Users\\alice\\customization.schema.json",
  "\\\\server\\share\\customization.schema.json",
  "C:\\Users\\alice\\customization.schema.json",
  "file:///Users/alice/customization.schema.json",
  "~/customization.schema.json",
  "~alice/customization.schema.json",
];
const MACHINE_IDS = [
  "file:///Users/alice/customization.json",
  "c:\\Users\\alice\\customization.json",
];

function repositoryDescriptor(overrides = {}) {
  return {
    schema_version: 1,
    id: "urn:skill-customization:example:review-local-archive",
    type: "semantic-overlay",
    name: "review-local-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      review: {
        revision: "0123456789abcdef",
      },
    },
    activation: { mode: "coexist" },
    ...overrides,
  };
}

test("descriptor accepts a strict coexist repository overlay", () => {
  assert.deepEqual(validateDescriptor(repositoryDescriptor()), []);
});

test("runtime selectors cannot point into excluded owned-payload paths", () => {
  for (const key of ["entrypoint", "customization"]) {
    for (const value of [
      "customization.json",
      "customization.json/runtime.md",
      "CUSTOMIZATION.JSON",
      "provenance",
      "provenance/runtime.md",
      "Provenance/runtime.md",
    ]) {
      const errors = validateDescriptor(repositoryDescriptor({ [key]: value }));
      assert.ok(
        errors.some(
          ({ path: pointer, message }) =>
            pointer === `/${key}` && /runtime-owned path/i.test(message),
        ),
      );
    }
  }
});

test("portable relative paths reject dot segments", () => {
  for (const key of ["entrypoint", "customization"]) {
    for (const value of ["./customization.json", "./provenance/runtime.md", "helpers/./run.md"]) {
      const errors = validateDescriptor(repositoryDescriptor({ [key]: value }));
      assert.ok(
        errors.some(
          ({ path: pointer, message }) =>
            pointer === `/${key}` && /portable relative path/i.test(message),
        ),
      );
    }
  }
});

test("descriptor keeps private repositories as repository sources and accepts opaque local IDs", () => {
  const privateRepository = repositoryDescriptor({
    source: {
      ...repositoryDescriptor().source,
      repository: "https://git.example.internal/team/private-skills",
    },
  });
  assert.deepEqual(validateDescriptor(privateRepository), []);
  const local = repositoryDescriptor({
    source: {
      skill_name: "review",
      kind: "local",
      license: "Proprietary",
      effective_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      identity:
        "local:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
  assert.deepEqual(validateDescriptor(local), []);
});

test("descriptor enforces stable names, source variants, and activation rules", () => {
  const descriptor = repositoryDescriptor({
    name: "review",
    activation: { mode: "coexist", precedence: "customization-first" },
    source: {
      skill_name: "review",
      kind: "local",
      license: "MIT",
      effective_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      identity: "/Users/alice/private-skill",
      auth: "token",
    },
    bindings: [],
  });
  const errors = validateDescriptor(descriptor);
  assert.ok(errors.some(({ path }) => path === "/bindings"));
  assert.ok(errors.some(({ path }) => path === "/source/identity"));
  assert.ok(errors.some(({ path }) => path === "/source/auth"));
  assert.ok(errors.some(({ path }) => path === "/activation/precedence"));
  assert.ok(errors.some(({ message }) => message.includes("coexist")));
});

test("descriptor repository URLs cannot carry credentials, query auth, or fragments", () => {
  for (const repository of [
    "https://token@github.com/example/skills",
    "https://github.com/example/skills?token=secret",
    "https://github.com/example/skills#private",
  ]) {
    const errors = validateDescriptor(
      repositoryDescriptor({
        source: { ...repositoryDescriptor().source, repository },
      }),
    );
    assert.ok(errors.some(({ path }) => path === "/source/repository"));
  }
});

test("descriptor rejects machine-local identifiers and schema locators", () => {
  for (const id of MACHINE_IDS) {
    const errors = validateDescriptor(repositoryDescriptor({ id }));
    assert.ok(errors.some(({ path: pointer }) => pointer === "/id"));
  }

  for (const schema of MACHINE_PATHS) {
    const errors = validateDescriptor(
      repositoryDescriptor({ $schema: schema }),
    );
    assert.ok(errors.some(({ path: pointer }) => pointer === "/$schema"));
  }

  for (const value of MACHINE_PATHS) {
    const licenseErrors = validateDescriptor(repositoryDescriptor({
      source: { ...repositoryDescriptor().source, license: value },
    }));
    assert.ok(
      licenseErrors.some(({ path: pointer }) => pointer === "/source/license"),
    );

    const revisionErrors = validateDescriptor(repositoryDescriptor({
      source: {
        ...repositoryDescriptor().source,
        review: { ...repositoryDescriptor().source.review, revision: value },
      },
    }));
    assert.ok(
      revisionErrors.some(
        ({ path: pointer }) => pointer === "/source/review/revision",
      ),
    );
  }
});

test("JSON Schema and runtime share machine-path exclusions", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../customization.schema.json", import.meta.url), "utf8"),
  );
  const reference = "#/$defs/nonMachinePathString";
  assert.equal(schema.properties.$schema.$ref, reference);
  assert.equal(schema.$defs.license.$ref, reference);
  assert.equal(
    schema.$defs.repositorySource.properties.review.properties.revision.$ref,
    reference,
  );
  const exclusions = schema.$defs.nonMachinePathString.allOf.map(
    ({ not }) => new RegExp(not.pattern),
  );
  const idPattern = new RegExp(schema.$defs.stableId.pattern);
  assert.equal(schema.properties.entrypoint.$ref, "#/$defs/runtimePath");
  assert.equal(schema.properties.customization.$ref, "#/$defs/runtimePath");
  const runtimeExclusion = new RegExp(
    schema.$defs.runtimePath.allOf.find(({ not }) => not)?.not.pattern,
  );
  const relativePath = new RegExp(schema.$defs.relativePath.pattern);
  for (const value of [
    "customization.json",
    "CUSTOMIZATION.JSON",
    "provenance",
    "provenance/run.md",
    "Provenance/run.md",
  ]) {
    assert.equal(runtimeExclusion.test(value), true);
  }
  for (const value of ["SKILL.md", "CUSTOMIZATION.md", "helpers/run.md"]) {
    assert.equal(runtimeExclusion.test(value), false);
  }
  for (const value of ["./customization.json", "./provenance/run.md", "helpers/./run.md"]) {
    assert.equal(relativePath.test(value), false);
  }
  for (const value of ["SKILL.md", "helpers/run.md"]) {
    assert.equal(relativePath.test(value), true);
  }

  for (const id of MACHINE_IDS) assert.equal(idPattern.test(id), false);
  for (const id of [
    "urn:skill-customization:example:review-local-archive",
    "https://example.com/customizations/review-local-archive",
  ]) {
    assert.equal(idPattern.test(id), true);
  }

  for (const value of MACHINE_PATHS) {
    assert.equal(isMachineAbsolutePath(value), true);
    assert.equal(exclusions.some(pattern => pattern.test(value)), true);
  }
  for (const value of [
    "MIT",
    "refs/heads/main",
    "schema/customization.schema.json",
    "https://skill-customization.dev/schema/customization-v1.json",
  ]) {
    assert.equal(isMachineAbsolutePath(value), false);
    assert.equal(exclusions.some(pattern => pattern.test(value)), false);
  }
});

test("replace requires an equal source name and deterministic precedence", () => {
  const valid = repositoryDescriptor({
    name: "review",
    activation: { mode: "replace", precedence: "customization-first" },
  });
  assert.deepEqual(validateDescriptor(valid), []);

  const invalid = repositoryDescriptor({ activation: { mode: "replace" } });
  const errors = validateDescriptor(invalid);
  assert.ok(errors.some(({ path }) => path === "/activation/precedence"));
  assert.ok(errors.some(({ message }) => message.includes("replace")));
});

test("fork requires relative snapshot and diff provenance", () => {
  const valid = repositoryDescriptor({
    type: "fork",
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      diff_fingerprint:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  });
  assert.deepEqual(validateDescriptor(valid), []);

  const invalid = repositoryDescriptor({
    type: "fork",
    fork: {
      snapshot: "/tmp/source",
      diff: "../source.diff",
      snapshot_fingerprint:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      diff_fingerprint:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  });
  const errors = validateDescriptor(invalid);
  assert.equal(errors.filter(({ path }) => path.startsWith("/fork/")).length, 2);
});

test("descriptor supports recursive customization sources and requires reviewed overlay materialization for forks", () => {
  const source = {
    skill_name: "review-team-base",
    kind: "customization",
    id: "urn:skill-customization:example:review-team-base",
    type: "semantic-overlay",
    license: "MIT",
    effective_fingerprint:
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  assert.deepEqual(validateDescriptor(repositoryDescriptor({ source })), []);

  const fork = {
    snapshot: "provenance/source",
    diff: "provenance/source.diff",
    snapshot_fingerprint:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    diff_fingerprint:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  };
  const missing = validateDescriptor(repositoryDescriptor({
    type: "fork",
    source,
    fork,
  }));
  assert.ok(missing.some(({ path: pointer }) => pointer === "/fork/materialization"));

  const valid = repositoryDescriptor({
    type: "fork",
    source,
    fork: {
      ...fork,
      materialization: {
        source_effective_fingerprint: source.effective_fingerprint,
        snapshot_fingerprint: fork.snapshot_fingerprint,
        reviewed_at: "2026-08-09T00:00:00Z",
        evidence: "Reviewed the checked base workflow and ordered deltas.",
      },
    },
  });
  assert.deepEqual(validateDescriptor(valid), []);
  assert.deepEqual(
    validateDescriptor(repositoryDescriptor({
      type: "fork",
      source: { ...source, type: "fork" },
      fork,
    })),
    [],
  );
});

test("reader checks folder/name equality and inventory collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-"));
  const descriptorDir = path.join(root, "review-local-archive");
  await mkdir(descriptorDir);
  const descriptorPath = path.join(descriptorDir, "customization.json");
  await writeFile(descriptorPath, JSON.stringify(repositoryDescriptor()));
  await writeFile(path.join(descriptorDir, "SKILL.md"), "# Skill\n");
  await writeFile(
    path.join(descriptorDir, "CUSTOMIZATION.md"),
    "# Customization\n",
  );

  const descriptor = await readDescriptor(descriptorPath, {
    inventory: [{ id: "urn:another", name: "other" }],
  });
  assert.equal(descriptor.name, "review-local-archive");

  await assert.rejects(
    readDescriptor(descriptorPath, {
      inventory: [{ id: "urn:another", name: "review-local-archive" }],
    }),
    /inventory collision/,
  );
  const differentFolder = path.join(root, "different-folder");
  await mkdir(differentFolder);
  const misplacedDescriptor = path.join(differentFolder, "customization.json");
  await writeFile(misplacedDescriptor, JSON.stringify(repositoryDescriptor()));
  await writeFile(path.join(differentFolder, "SKILL.md"), "# Skill\n");
  await writeFile(path.join(differentFolder, "CUSTOMIZATION.md"), "# Delta\n");
  await assert.rejects(
    readDescriptor(misplacedDescriptor, {
      expectedFolder: "review-local-archive",
    }),
    /folder name/,
  );
});

test("reader requires entrypoint and customization artifacts to be files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "descriptor-types-"));
  const descriptorDir = path.join(root, "review-local-archive");
  await mkdir(path.join(descriptorDir, "SKILL.md"), { recursive: true });
  await mkdir(path.join(descriptorDir, "CUSTOMIZATION.md"), { recursive: true });
  const descriptorPath = path.join(descriptorDir, "customization.json");
  await writeFile(descriptorPath, JSON.stringify(repositoryDescriptor()));
  await assert.rejects(readDescriptor(descriptorPath), /regular file/i);
});

test("reader requires fork snapshot and diff to be owned, non-symlinked provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-descriptor-"));
  const descriptorDir = path.join(root, "review-local-archive");
  const external = path.join(root, "external");
  await mkdir(path.join(descriptorDir, "provenance"), { recursive: true });
  await mkdir(external);
  await writeFile(path.join(external, "SKILL.md"), "external\n");
  await writeFile(path.join(descriptorDir, "SKILL.md"), "fork\n");
  await writeFile(path.join(descriptorDir, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(path.join(descriptorDir, "provenance", "source.diff"), "diff\n");
  await symlink(external, path.join(descriptorDir, "provenance", "source"));
  const descriptorPath = path.join(descriptorDir, "customization.json");
  await writeFile(
    descriptorPath,
    JSON.stringify(
      repositoryDescriptor({
        type: "fork",
        fork: {
          snapshot: "provenance/source",
          diff: "provenance/source.diff",
          snapshot_fingerprint:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          diff_fingerprint:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        },
      }),
    ),
  );
  await assert.rejects(readDescriptor(descriptorPath), /not owned|symbolic link/i);
});

test("reader requires a fork snapshot directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-snapshot-type-"));
  const descriptorDir = path.join(root, "review-local-archive");
  const provenance = path.join(descriptorDir, "provenance");
  await mkdir(provenance, { recursive: true });
  await writeFile(path.join(descriptorDir, "SKILL.md"), "fork\n");
  await writeFile(path.join(descriptorDir, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(path.join(provenance, "source"), "source\n");
  await writeFile(path.join(provenance, "source.diff"), "diff\n");
  const descriptorPath = path.join(descriptorDir, "customization.json");
  await writeFile(
    descriptorPath,
    JSON.stringify(
      repositoryDescriptor({
        type: "fork",
        fork: {
          snapshot: "provenance/source",
          diff: "provenance/source.diff",
          snapshot_fingerprint:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          diff_fingerprint:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        },
      }),
    ),
  );

  await assert.rejects(readDescriptor(descriptorPath), /snapshot.*directory/i);
});
