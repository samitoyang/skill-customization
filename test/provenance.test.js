import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProvenance,
  checkProvenanceSelection,
  confirmProvenanceDecision,
} from "../src/provenance.js";

test("Provenance evidence is normalized, ordered, and immutable", () => {
  const observations = [
    {
      kind: "embedded",
      repository: "git@github.com:example/skills.git",
      upstream_path: "./skills/review",
    },
    {
      kind: "manager",
      manager: "asm",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review/SKILL.md",
    },
    {
      kind: "plugin",
      host: "codex",
      plugin: "reviewer",
      marketplace: "official",
      identity: "local:plugin:codex:official:reviewer",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
    },
    {
      kind: "git",
      repository: "https://github.com/example/skills",
      upstreamPath: "skills/review",
    },
    { kind: "explicit", path: "/workspace/skills/review" },
  ];

  const decision = checkProvenance({ observations });

  assert.deepEqual(
    decision.evidence.map(({ kind }) => kind),
    ["explicit", "git", "plugin", "manager", "embedded"],
  );
  assert.deepEqual(decision.provenance, [
    "repository:https://github.com/example/skills#skills/review/SKILL.md",
  ]);
  assert.deepEqual(decision.conflicts, []);
  assert.equal(decision.conflict, false);
  assert.equal(decision.selectionEligible, true);
  assert.equal(decision.diagnostics.length, 0);

  assert.notEqual(decision.evidence, observations);
  assert.throws(
    () => decision.evidence.push({ kind: "explicit", path: "/other" }),
    TypeError,
  );
  assert.throws(
    () => {
      decision.evidence[0].path = "/other";
    },
    TypeError,
  );
  assert.equal(observations[0].upstream_path, "./skills/review");
});

test("Provenance conflicts remain visible and a matching confirmation makes a copy selectable", () => {
  const observations = [
    { kind: "git", repository: "https://github.com/example/first" },
    {
      kind: "plugin",
      host: "codex",
      plugin: "reviewer",
      marketplace: "official",
      identity: "local:plugin:codex:official:reviewer",
      repository: "https://github.com/example/second",
    },
  ];

  const conflicted = checkProvenance({ observations });
  assert.equal(conflicted.conflict, true);
  assert.equal(conflicted.selectionEligible, false);
  assert.deepEqual(conflicted.provenance, [
    "repository:https://github.com/example/first",
    "repository:https://github.com/example/second",
  ]);
  assert.ok(conflicted.conflicts.some(({ kind }) => kind === "repository"));

  const auditEvidence = { actor: "human", reason: "selected the installed copy" };
  const confirmed = checkProvenance({
    observations,
    confirmation: {
      provenance: "repository:https://github.com/example/second",
      path: "/plugins/reviewer",
      evidence: auditEvidence,
    },
  });
  assert.equal(confirmed.selectionEligible, true);
  assert.equal(confirmed.selectedProvenance, "repository:https://github.com/example/second");
  assert.equal(confirmed.evidence.at(-1).kind, "confirmation");
  assert.deepEqual(confirmed.evidence.at(-1).confirmationEvidence, {
    actor: "human",
    reason: "selected the installed copy",
  });
  assert.notEqual(
    confirmed.evidence.at(-1).confirmationEvidence,
    auditEvidence,
  );
  assert.throws(
    () => {
      confirmed.evidence.at(-1).confirmationEvidence.actor = "other";
    },
    TypeError,
  );
  assert.equal(auditEvidence.actor, "human");
});

test("Provenance keeps local plugin identity distinct from repository provenance", () => {
  const decision = checkProvenance({
    observations: [{
      kind: "plugin",
      host: "cursor",
      plugin: "local-reviewer",
      marketplace: "local",
      identity: "local:plugin:cursor:local:local-reviewer",
    }],
  });

  assert.deepEqual(decision.provenance, [
    "local:plugin:cursor:local:local-reviewer",
  ]);
  assert.equal(decision.repository, undefined);
  assert.equal(decision.conflict, false);
  assert.equal(decision.selectionEligible, true);
});

test("Malformed Provenance observations return stable diagnostics at the evidence seam", () => {
  const decision = checkProvenance({
    observations: [
      { kind: "git", repository: "not a repository locator" },
      { kind: "future", value: "unsupported" },
    ],
  });

  assert.equal(decision.selectionEligible, false);
  assert.deepEqual(
    decision.diagnostics.map(({ code }) => code),
    ["INVALID_REPOSITORY_EVIDENCE", "UNKNOWN_PROVENANCE_KIND"],
  );
  assert.deepEqual(decision.evidence, []);
});

test("Confirmation validation is owned by Provenance evidence", () => {
  const observations = [{
    kind: "git",
    repository: "https://github.com/example/skills",
  }];

  const mismatch = checkProvenance({
    observations,
    confirmation: {
      provenance: "repository:https://github.com/example/other",
      path: "/skills/review",
    },
  });
  assert.equal(mismatch.selectionEligible, false);
  assert.deepEqual(mismatch.diagnostics.map(({ code }) => code), [
    "PROVENANCE_CONFIRMATION_MISMATCH",
  ]);

  const invalidEvidence = checkProvenance({
    observations,
    confirmation: {
      path: "/skills/review",
      evidence: [],
    },
  });
  assert.equal(invalidEvidence.selectionEligible, false);
  assert.deepEqual(invalidEvidence.diagnostics.map(({ code }) => code), [
    "INVALID_CONFIRMATION_EVIDENCE",
  ]);

  const invalidKind = checkProvenance({
    observations,
    confirmation: {
      kind: "git",
      repository: "https://github.com/example/skills",
    },
  });
  assert.equal(invalidKind.selectionEligible, false);
  assert.deepEqual(invalidKind.diagnostics.map(({ code }) => code), [
    "INVALID_CONFIRMATION_KIND",
  ]);
});

test("Provenance rejects contradictory aliases and nested source records", () => {
  const upstreamConflict = checkProvenance({
    observations: [{
      kind: "git",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review",
      upstreamPath: "skills/other",
    }],
  });
  assert.equal(upstreamConflict.selectionEligible, false);
  assert.deepEqual(upstreamConflict.diagnostics.map(({ code }) => code), [
    "CONTRADICTORY_UPSTREAM_EVIDENCE",
  ]);

  const nestedConflict = checkProvenance({
    observations: [{
      kind: "plugin",
      host: "codex",
      plugin: "reviewer",
      marketplace: "official",
      repository: "https://github.com/example/one",
      provenance: {
        kind: "plugin",
        repository: "https://github.com/example/two",
      },
    }],
  });
  assert.equal(nestedConflict.selectionEligible, false);
  assert.deepEqual(nestedConflict.diagnostics.map(({ code }) => code), [
    "CONTRADICTORY_PROVENANCE_EVIDENCE",
  ]);
});

test("a prior checked decision is the input to confirmation", () => {
  const decision = checkProvenance({
    observations: [{
      kind: "git",
      repository: "https://github.com/example/skills",
    }],
  });
  const confirmed = confirmProvenanceDecision(decision, {
    path: "/skills/review",
    evidence: { actor: "human" },
  });

  assert.equal(confirmed.selectionEligible, true);
  assert.equal(confirmed.selectedProvenance, "repository:https://github.com/example/skills");
  assert.equal(confirmed.evidence.at(-1).kind, "confirmation");
});

test("descriptor selection reuses the checked repository identity and path rules", () => {
  const repository = "https://github.com/example/skills";
  const expectedSource = {
    kind: "repository",
    repository,
    upstream_path: "skills/review/SKILL.md",
  };
  const repositoryOnly = checkProvenanceSelection(
    checkProvenance({
      observations: [{ kind: "plugin", host: "codex", plugin: "reviewer", marketplace: "official", repository }],
    }),
    expectedSource,
  );
  assert.equal(repositoryOnly.selectionEligible, true);
  assert.deepEqual(repositoryOnly.compatibleProvenance, [`repository:${repository}`]);

  const incompatiblePath = checkProvenanceSelection(
    checkProvenance({
      observations: [{
        kind: "manager",
        manager: "asm",
        repository,
        upstream_path: "skills/other/SKILL.md",
      }],
    }),
    expectedSource,
  );
  assert.equal(incompatiblePath.selectionEligible, false);
  assert.deepEqual(incompatiblePath.diagnostics.map(({ code }) => code), [
    "PROVENANCE_SOURCE_UPSTREAM_PATH_MISMATCH",
  ]);

  const noEvidence = checkProvenanceSelection(
    checkProvenance(),
    expectedSource,
  );
  assert.equal(noEvidence.selectionEligible, true);
  assert.deepEqual(noEvidence.compatibleProvenance, []);
});

test("a confirmed exact upstream identity can resolve an otherwise conflicting decision", () => {
  const repository = "https://github.com/example/skills";
  const expected = `repository:${repository}#skills/review/SKILL.md`;
  const decision = checkProvenance({
    observations: [
      { kind: "git", repository, upstream_path: "skills/review/SKILL.md" },
      { kind: "manager", manager: "asm", repository, upstream_path: "skills/other/SKILL.md" },
    ],
  });
  assert.equal(checkProvenanceSelection(decision, {
    kind: "repository",
    repository,
    upstream_path: "skills/review/SKILL.md",
  }).selectionEligible, false);

  const confirmed = checkProvenanceSelection(
    confirmProvenanceDecision(decision, {
      provenance: expected,
      path: "/workspace/review",
      evidence: { actor: "human" },
    }),
    {
      kind: "repository",
      repository,
      upstream_path: "skills/review/SKILL.md",
    },
  );
  assert.equal(confirmed.selectionEligible, true);
  assert.equal(confirmed.selectedProvenance, expected);
});

test("descriptor selection reuses checked local identity evidence", () => {
  const expectedIdentity = `local:sha256:${"a".repeat(64)}`;
  const source = {
    kind: "local",
    identity: expectedIdentity,
  };
  const mismatch = checkProvenanceSelection(
    checkProvenance({
      observations: [{
        kind: "embedded",
        identity: `local:sha256:${"b".repeat(64)}`,
      }],
    }),
    source,
  );
  assert.equal(mismatch.selectionEligible, false);
  assert.deepEqual(mismatch.diagnostics.map(({ code }) => code), [
    "PROVENANCE_SOURCE_LOCAL_IDENTITY_MISMATCH",
  ]);

  const pluginBacked = checkProvenanceSelection(
    checkProvenance({
      observations: [{
        kind: "plugin",
        host: "codex",
        plugin: "reviewer",
        marketplace: "official",
        identity: "local:plugin:codex:official:reviewer",
      }],
    }),
    source,
  );
  assert.equal(pluginBacked.selectionEligible, true);
});
