import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fingerprintFile,
  fingerprintPath,
  payloadFingerprint,
} from "../src/fingerprint.js";
import { generateLocalIdentity } from "../src/normalization.js";
import {
  compatibilityCachePath,
  reconcileCustomization,
} from "../src/reconcile.js";

test("compatibility cache uses XDG then the agents fallback", () => {
  assert.equal(
    compatibilityCachePath({ env: { XDG_STATE_HOME: "/state" }, home: "/home/alice" }),
    "/state/skill-customization/compatibility.json",
  );
  assert.equal(
    compatibilityCachePath({ env: {}, home: "/home/alice" }),
    "/home/alice/.agents/skill-customization/compatibility.json",
  );
});

async function overlayFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reconcile-"));
  const customizationRoot = path.join(root, "review-local-archive");
  const sourceRoot = path.join(root, "source");
  await mkdir(customizationRoot);
  await mkdir(sourceRoot);
  await writeFile(path.join(customizationRoot, "SKILL.md"), "customized\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Preserve local archive behavior.\n");
  await writeFile(path.join(sourceRoot, "SKILL.md"), "reviewed source\n");
  const reviewFingerprint = await fingerprintPath(sourceRoot);
  const ownedFingerprint = await payloadFingerprint(customizationRoot);
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-local-archive",
    type: "semantic-overlay",
    name: "review-local-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: ownedFingerprint },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: reviewFingerprint,
      review: { revision: "abc" },
    },
    activation: { mode: "coexist" },
  };
  return { root, customizationRoot, sourceRoot, descriptor };
}

test("overlay requires a live source and accepts an exact checkpoint", async () => {
  const fixture = await overlayFixture();
  await assert.rejects(
    reconcileCustomization({
      descriptor: fixture.descriptor,
      customizationRoot: fixture.customizationRoot,
    }),
    (error) => error.code === "LIVE_SOURCE_REQUIRED",
  );
  const result = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
  });
  assert.equal(result.status, "compatible");
  assert.equal(result.checkpointMatch, true);
});

test("overlay follows an installed symlink to a live source directory", async () => {
  const fixture = await overlayFixture();
  const alias = path.join(fixture.root, "installed-review");
  await symlink(fixture.sourceRoot, alias);

  const result = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: alias,
  });

  assert.equal(result.status, "compatible");
  assert.equal(result.checkpointMatch, true);
});

test("overlay reconciliation rejects a source-internal entrypoint symlink", async () => {
  const fixture = await overlayFixture();
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "reconcile-external-"));
  const external = path.join(externalRoot, "workflow.md");
  await writeFile(external, "unreviewed workflow\n");
  await unlink(path.join(fixture.sourceRoot, "SKILL.md"));
  await symlink(external, path.join(fixture.sourceRoot, "SKILL.md"));

  await assert.rejects(
    reconcileCustomization({
      descriptor: fixture.descriptor,
      customizationRoot: fixture.customizationRoot,
      sourcePath: fixture.sourceRoot,
    }),
    (error) =>
      error.code === "LIVE_SOURCE_REQUIRED"
      && /entrypoint.*symbolic link/i.test(error.message),
  );
});

test("drift stops as ambiguous unless semantic compatibility is cached by fingerprint", async () => {
  const fixture = await overlayFixture();
  const cachePath = path.join(fixture.root, "state", "compatibility.json");
  await writeFile(path.join(fixture.sourceRoot, "SKILL.md"), "changed source\n");
  await chmod(path.join(fixture.sourceRoot, "SKILL.md"), 0o444);
  const before = await readFile(path.join(fixture.sourceRoot, "SKILL.md"), "utf8");
  const ambiguous = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
  });
  assert.equal(ambiguous.status, "ambiguous-drift");
  assert.equal(ambiguous.stopped, true);
  assert.equal(ambiguous.flags.ambiguousDrift, true);

  const checked = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
    semanticReconciler: async () => ({ compatible: true, evidence: "delta still applies" }),
  });
  assert.equal(checked.status, "compatible");
  assert.equal(checked.cached, false);
  const cached = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
  });
  assert.equal(cached.status, "compatible");
  assert.equal(cached.cached, true);
  await writeFile(
    path.join(fixture.customizationRoot, "CUSTOMIZATION.md"),
    "A changed semantic delta.\n",
  );
  const invalidated = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
  });
  assert.equal(invalidated.status, "owned-payload-drift");
  assert.equal(invalidated.cached, false);
  assert.equal(await readFile(path.join(fixture.sourceRoot, "SKILL.md"), "utf8"), before);
});

test("compatibility cache entries bind the selected delta path and role", async () => {
  const fixture = await overlayFixture();
  const cachePath = path.join(fixture.root, "state", "compatibility.json");
  await writeFile(
    path.join(fixture.customizationRoot, "ALTERNATE.md"),
    "Apply a different reviewed delta.\n",
  );
  fixture.descriptor.owned_payload.reviewed_fingerprint = await payloadFingerprint(
    fixture.customizationRoot,
  );
  await writeFile(path.join(fixture.sourceRoot, "SKILL.md"), "changed source\n");

  const checked = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
    semanticReconciler: async () => ({
      compatible: true,
      evidence: "reviewed the default delta",
    }),
  });
  assert.equal(checked.status, "compatible");

  fixture.descriptor.customization = "ALTERNATE.md";
  const changedSelector = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath,
  });
  assert.equal(changedSelector.status, "ambiguous-drift");
  assert.equal(changedSelector.cached, false);
});

test("concurrent compatibility reviews preserve distinct cache entries", async () => {
  const first = await overlayFixture();
  const second = await overlayFixture();
  second.descriptor.id = "urn:skill-customization:fixture:review-second-delta";
  const cachePath = path.join(first.root, "state", "compatibility.json");
  await writeFile(path.join(first.sourceRoot, "SKILL.md"), "first drift\n");
  await writeFile(path.join(second.sourceRoot, "SKILL.md"), "second drift\n");

  await Promise.all(
    [first, second].map((fixture) =>
      reconcileCustomization({
        descriptor: fixture.descriptor,
        customizationRoot: fixture.customizationRoot,
        sourcePath: fixture.sourceRoot,
        cachePath,
        semanticReconciler: async () => ({
          compatible: true,
          evidence: "concurrent semantic review",
        }),
      }),
    ),
  );

  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(
    Object.keys(cache.compatibility).sort(),
    [first.descriptor.id, second.descriptor.id].sort(),
  );
});

test("local overlay identity is its checkpoint and changed bytes stop for review", async () => {
  const fixture = await overlayFixture();
  const sourceFingerprint = await fingerprintFile(
    path.join(fixture.sourceRoot, "SKILL.md"),
  );
  fixture.descriptor.source = {
    skill_name: "review",
    kind: "local",
    license: "MIT",
    effective_fingerprint: await fingerprintPath(fixture.sourceRoot),
    identity: generateLocalIdentity({
      skillName: "review",
      fingerprint: sourceFingerprint,
    }),
  };
  const exact = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath: null,
  });
  assert.equal(exact.status, "compatible");
  assert.equal(exact.checkpointMatch, true);
  assert.equal(exact.sourceIdentity, fixture.descriptor.source.identity);
  await writeFile(path.join(fixture.sourceRoot, "SKILL.md"), "local drift\n");
  const drift = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    cachePath: null,
  });
  assert.equal(drift.status, "ambiguous-drift");
  assert.equal(drift.checkpointMatch, false);
});

test("semantic reconciliation flags absorbed deltas", async () => {
  const fixture = await overlayFixture();
  await writeFile(path.join(fixture.sourceRoot, "SKILL.md"), "changed source\n");
  const result = await reconcileCustomization({
    descriptor: fixture.descriptor,
    customizationRoot: fixture.customizationRoot,
    sourcePath: fixture.sourceRoot,
    semanticReconciler: async () => ({
      compatible: false,
      absorbedDeltas: ["local archive is now upstream"],
    }),
    cachePath: null,
  });
  assert.equal(result.status, "absorbed-delta");
  assert.equal(result.stopped, true);
  assert.deepEqual(result.flags.absorbedDeltas, ["local archive is now upstream"]);
});

test("overlay reconciliation rejects customization paths that escape through symlinks", async () => {
  const fixture = await overlayFixture();
  const external = path.join(fixture.root, "external-entrypoint.md");
  await writeFile(external, "external customization\n");
  await unlink(path.join(fixture.customizationRoot, "SKILL.md"));
  await symlink(external, path.join(fixture.customizationRoot, "SKILL.md"));

  await assert.rejects(
    reconcileCustomization({
      descriptor: fixture.descriptor,
      customizationRoot: fixture.customizationRoot,
      sourcePath: fixture.sourceRoot,
      cachePath: null,
    }),
    (error) => error.code === "CUSTOMIZATION_PATH_NOT_OWNED",
  );
});

async function forkDiffFixture({
  forkEntrypoint = "fork\n",
  diff = "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-snapshot\n+fork\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+Fork rationale.\n",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-diff-proof-"));
  const customizationRoot = path.join(root, "review-fork");
  const snapshotRoot = path.join(customizationRoot, "provenance", "source");
  const snapshotEntrypoint = path.join(snapshotRoot, "SKILL.md");
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(customizationRoot, "SKILL.md"), forkEntrypoint);
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Fork rationale.\n");
  await writeFile(snapshotEntrypoint, "snapshot\n");
  const diffPath = path.join(customizationRoot, "provenance", "source.diff");
  await writeFile(diffPath, diff);
  const snapshotFingerprint = await fingerprintPath(snapshotRoot);
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-fork-proof",
    type: "fork",
    name: "review-fork",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: {
        revision: "abc",
      },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };
  await writeFile(
    path.join(customizationRoot, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return { customizationRoot, descriptor, snapshotRoot };
}

test("fork reconciliation is independent of a runtime source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-"));
  const customizationRoot = path.join(root, "review-fork");
  await mkdir(path.join(customizationRoot, "provenance", "source"), { recursive: true });
  await writeFile(path.join(customizationRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Fork rationale.\n");
  const snapshotEntrypoint = path.join(
    customizationRoot,
    "provenance",
    "source",
    "SKILL.md",
  );
  await writeFile(snapshotEntrypoint, "snapshot\n");
  await writeFile(
    path.join(customizationRoot, "provenance", "source.diff"),
    [
      "diff --git a/SKILL.md b/SKILL.md",
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -1 +1 @@",
      "-snapshot",
      "+fork",
      "--- /dev/null",
      "+++ b/CUSTOMIZATION.md",
      "@@ -0,0 +1 @@",
      "+Fork rationale.",
      "",
    ].join("\n"),
  );
  const snapshotCheckpoint = await fingerprintFile(snapshotEntrypoint);
  const snapshotFingerprint = await fingerprintPath(
    path.join(customizationRoot, "provenance", "source"),
  );
  const diffPath = path.join(customizationRoot, "provenance", "source.diff");
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:review-fork",
    type: "fork",
    name: "review-fork",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: {
        revision: "abc",
      }
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    }
  };
  const result = await reconcileCustomization({ descriptor, customizationRoot });
  assert.equal(result.status, "fork-ready");
  assert.equal(result.runtimeSourceRequired, false);
  assert.match(result.provenance.snapshotFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.provenance.snapshotEntrypointFingerprint, snapshotCheckpoint);
  assert.match(result.provenance.diffFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.provenance.diffTargets, ["SKILL.md", "CUSTOMIZATION.md"]);
});

test("full-source fork snapshots must match the reviewed source checkpoint", async () => {
  for (const kind of ["repository", "local"]) {
    const fixture = await forkDiffFixture();
    fixture.descriptor.source = kind === "repository"
      ? {
          ...fixture.descriptor.source,
          effective_fingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }
      : {
          skill_name: "review",
          kind: "local",
          license: "MIT",
          effective_fingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          identity:
            "local:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        };

    await assert.rejects(
      reconcileCustomization(fixture),
      (error) =>
        error.code === "INCOMPLETE_FORK_PROVENANCE"
        && /reviewed full-source effective fingerprint/i.test(error.message),
      `${kind} fork should reject an unrelated reviewed source checkpoint`,
    );
  }
});

test("fork reconciliation rejects single-file snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-file-snapshot-"));
  const customizationRoot = path.join(root, "review-fork");
  const provenance = path.join(customizationRoot, "provenance");
  await mkdir(provenance, { recursive: true });
  await writeFile(path.join(customizationRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Fork rationale.\n");
  const snapshot = path.join(provenance, "source");
  await writeFile(snapshot, "snapshot\n");
  const diffPath = path.join(provenance, "source.diff");
  await writeFile(
    diffPath,
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-snapshot\n+fork\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+Fork rationale.\n",
  );
  const snapshotFingerprint = await fingerprintPath(snapshot);
  const descriptor = {
    schema_version: 1,
    id: "urn:skill-customization:fixture:file-snapshot",
    type: "fork",
    name: "review-fork",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: snapshotFingerprint,
      review: { revision: "abc" },
    },
    activation: { mode: "coexist" },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: snapshotFingerprint,
      diff_fingerprint: await fingerprintFile(diffPath),
    },
  };

  await assert.rejects(
    reconcileCustomization({ descriptor, customizationRoot }),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /snapshot must be a directory/i.test(error.message),
  );
});

test("fork provenance accepts a helper-only diff that reconstructs the full payload", async () => {
  const fixture = await forkDiffFixture({
    forkEntrypoint: "snapshot\n",
    diff: "--- a/OTHER.md\n+++ b/OTHER.md\n@@ -1 +1 @@\n-old\n+new\n--- /dev/null\n+++ b/CUSTOMIZATION.md\n@@ -0,0 +1 @@\n+Fork rationale.\n",
  });
  await writeFile(path.join(fixture.snapshotRoot, "OTHER.md"), "old\n");
  await writeFile(path.join(fixture.customizationRoot, "OTHER.md"), "new\n");
  fixture.descriptor.fork.snapshot_fingerprint = await fingerprintPath(
    fixture.snapshotRoot,
  );
  fixture.descriptor.source.effective_fingerprint =
    fixture.descriptor.fork.snapshot_fingerprint;
  fixture.descriptor.owned_payload.reviewed_fingerprint = await payloadFingerprint(
    fixture.customizationRoot,
  );

  const result = await reconcileCustomization(fixture);

  assert.equal(result.status, "fork-ready");
  assert.deepEqual(result.provenance.diffTargets, ["OTHER.md", "CUSTOMIZATION.md"]);
});

test("fork provenance detects an unreviewed extra owned helper", async () => {
  const fixture = await forkDiffFixture();
  await writeFile(path.join(fixture.customizationRoot, "EXTRA.md"), "extra\n");

  await assert.rejects(
    reconcileCustomization(fixture),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /owned payload fingerprint/i.test(error.message),
  );
});

test("fork provenance detects an unreviewed snapshot helper change", async () => {
  const fixture = await forkDiffFixture();
  await writeFile(path.join(fixture.snapshotRoot, "HELPER.md"), "source helper\n");
  await writeFile(path.join(fixture.customizationRoot, "HELPER.md"), "modified helper\n");

  await assert.rejects(
    reconcileCustomization(fixture),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /snapshot fingerprint/i.test(error.message),
  );
});

test("fork provenance rejects symbolic links in the owned payload", async () => {
  const fixture = await forkDiffFixture();
  const external = path.join(path.dirname(fixture.customizationRoot), "external-helper.md");
  await writeFile(external, "external\n");
  await symlink(external, path.join(fixture.customizationRoot, "HELPER.md"));

  await assert.rejects(
    reconcileCustomization(fixture),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /symbolic link.*HELPER\.md/i.test(error.message),
  );
});

test("fork provenance rejects an applicable diff that does not match the owned fork", async () => {
  const fixture = await forkDiffFixture({ forkEntrypoint: "different fork\n" });

  await assert.rejects(
    reconcileCustomization(fixture),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /owned fork/i.test(error.message),
  );
});

test("fork provenance rejects a diff that does not apply to its snapshot", async () => {
  const fixture = await forkDiffFixture({
    diff: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-other source\n+fork\n",
  });

  await assert.rejects(
    reconcileCustomization(fixture),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /does not apply/i.test(error.message),
  );
});

test("fork provenance rejects a snapshot that does not match its review checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-checkpoint-"));
  const customizationRoot = path.join(root, "review-fork");
  await mkdir(path.join(customizationRoot, "provenance", "source"), {
    recursive: true,
  });
  await writeFile(path.join(customizationRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(
    path.join(customizationRoot, "provenance", "source", "SKILL.md"),
    "unexpected snapshot\n",
  );
  await writeFile(
    path.join(customizationRoot, "provenance", "source.diff"),
    "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-source\n+fork\n",
  );
  const descriptor = {
    ...(await overlayFixture()).descriptor,
    id: "urn:skill-customization:fixture:review-fork-checkpoint",
    type: "fork",
    name: "review-fork",
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      diff_fingerprint: await fingerprintFile(
        path.join(customizationRoot, "provenance", "source.diff"),
      ),
    },
  };
  await assert.rejects(
    reconcileCustomization({ descriptor, customizationRoot }),
    (error) =>
      error.code === "INCOMPLETE_FORK_PROVENANCE"
      && /snapshot fingerprint/i.test(error.message),
  );
});

test("fork provenance rejects empty and malformed diffs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-diff-"));
  const customizationRoot = path.join(root, "review-fork");
  const snapshotRoot = path.join(customizationRoot, "provenance", "source");
  const snapshotEntrypoint = path.join(snapshotRoot, "SKILL.md");
  const diffPath = path.join(customizationRoot, "provenance", "source.diff");
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(path.join(customizationRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(snapshotEntrypoint, "source\n");
  const base = (await overlayFixture()).descriptor;
  const descriptor = {
    ...base,
    id: "urn:skill-customization:fixture:review-fork-diff",
    type: "fork",
    name: "review-fork",
    source: {
      ...base.source,
      effective_fingerprint: await fingerprintPath(snapshotRoot),
    },
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint: await fingerprintPath(snapshotRoot),
      diff_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };

  for (const invalidDiff of ["", "diff --git a/SKILL.md b/SKILL.md\n"]) {
    await writeFile(diffPath, invalidDiff);
    await assert.rejects(
      reconcileCustomization({ descriptor, customizationRoot }),
      (error) =>
        error.code === "INCOMPLETE_FORK_PROVENANCE"
        && /diff/i.test(error.message),
    );
  }
});

test("fork provenance rejects symlinked external snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fork-link-"));
  const customizationRoot = path.join(root, "review-fork");
  const external = path.join(root, "external-source");
  await mkdir(path.join(customizationRoot, "provenance"), { recursive: true });
  await mkdir(external);
  await writeFile(path.join(external, "SKILL.md"), "external\n");
  await writeFile(path.join(customizationRoot, "SKILL.md"), "fork\n");
  await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "delta\n");
  await writeFile(path.join(customizationRoot, "provenance", "source.diff"), "diff\n");
  await symlink(external, path.join(customizationRoot, "provenance", "source"));
  const descriptor = {
    ...(await overlayFixture()).descriptor,
    id: "urn:skill-customization:fixture:review-fork-link",
    type: "fork",
    name: "review-fork",
    owned_payload: {
      reviewed_fingerprint: await payloadFingerprint(customizationRoot),
    },
    fork: {
      snapshot: "provenance/source",
      diff: "provenance/source.diff",
      snapshot_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      diff_fingerprint: await fingerprintFile(
        path.join(customizationRoot, "provenance", "source.diff"),
      ),
    },
  };
  await assert.rejects(
    reconcileCustomization({ descriptor, customizationRoot }),
    (error) => error.code === "INCOMPLETE_FORK_PROVENANCE",
  );
});
