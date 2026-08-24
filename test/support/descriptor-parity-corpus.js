import {
  DESCRIPTOR_SCHEMA_GAPS,
  freezeDescriptorValue,
} from "../../src/descriptor-invariants.js";

const fingerprint = (character) => `sha256:${character.repeat(64)}`;

function repositoryDescriptor(overrides = {}) {
  return {
    schema_version: 1,
    id: "urn:skill-customization:example:review-local-archive",
    type: "semantic-overlay",
    name: "review-local-archive",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: ["lint-review"],
    owned_payload: { reviewed_fingerprint: fingerprint("b") },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: fingerprint("a"),
      review: { revision: "0123456789abcdef" },
    },
    activation: { mode: "coexist" },
    ...overrides,
  };
}

const localSource = {
  skill_name: "review",
  kind: "local",
  identity: `local:${fingerprint("c")}`,
  license: "Proprietary",
  effective_fingerprint: fingerprint("d"),
};
const customizationSource = (type) => ({
  skill_name: "review",
  kind: "customization",
  id: "urn:skill-customization:example:review-source",
  type,
  license: "MIT",
  effective_fingerprint: fingerprint("e"),
});
const fork = (materialization) => ({
  snapshot: "provenance/source",
  diff: "provenance/diffs/source.diff",
  snapshot_fingerprint: fingerprint("f"),
  diff_fingerprint: fingerprint("0"),
  ...(materialization ? {
    materialization: {
      source_effective_fingerprint: fingerprint("e"),
      snapshot_fingerprint: fingerprint("f"),
      reviewed_at: "2026-08-24T00:00:00Z",
      evidence: "reviewed fixture",
    },
  } : {}),
});

const caseOf = (name, descriptor, expected, gap) => freezeDescriptorValue({
  name,
  descriptor,
  expected,
  ...(gap ? { gap } : {}),
});

export const DESCRIPTOR_PARITY_CORPUS = freezeDescriptorValue([
  caseOf("repository-overlay-coexist", repositoryDescriptor({
    $schema: "https://skill-customization.dev/schema/customization-v1.json",
  }), { runtime: true, schema: true }),
  caseOf("local-replace", repositoryDescriptor({
    name: "review",
    source: localSource,
    activation: { mode: "replace", precedence: "customization-first" },
  }), { runtime: true, schema: true }),
  caseOf("fork-from-repository", repositoryDescriptor({ type: "fork", fork: fork(false) }), { runtime: true, schema: true }),
  caseOf("fork-from-fork-customization", repositoryDescriptor({
    type: "fork",
    source: customizationSource("fork"),
    fork: fork(false),
  }), { runtime: true, schema: true }),
  caseOf("fork-from-overlay-customization-materialized", repositoryDescriptor({
    type: "fork",
    source: customizationSource("semantic-overlay"),
    fork: fork(true),
  }), { runtime: true, schema: true }),
  caseOf("rejects-machine-local-schema", repositoryDescriptor({ $schema: "/Users/alice/customization.schema.json" }), { runtime: false, schema: false, diagnostic: "/$schema" }),
  caseOf("rejects-unknown-portable-field", repositoryDescriptor({ bindings: [] }), { runtime: false, schema: false, diagnostic: "/bindings" }),
  caseOf("rejects-duplicate-dependency", repositoryDescriptor({ dependencies: ["lint-review", "lint-review"] }), { runtime: false, schema: false, diagnostic: "/dependencies/1" }),
  caseOf("rejects-machine-local-license", repositoryDescriptor({ license: "/Users/alice/license" }), { runtime: false, schema: false, diagnostic: "/license" }),
  caseOf("rejects-excluded-runtime-selector", repositoryDescriptor({ entrypoint: "provenance/run.md" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-customization-json-runtime-selector", repositoryDescriptor({ entrypoint: "customization.json" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-case-insensitive-customization-json-runtime-selector", repositoryDescriptor({ entrypoint: "CUSTOMIZATION.JSON" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-provenance-root-runtime-selector", repositoryDescriptor({ entrypoint: "provenance" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-git-metadata-runtime-selector", repositoryDescriptor({ entrypoint: "helpers/.git/run.md" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-hg-metadata-runtime-selector", repositoryDescriptor({ entrypoint: "helpers/.Hg/run.md" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-svn-metadata-runtime-selector", repositoryDescriptor({ entrypoint: "helpers/.SVN/run.md" }), { runtime: false, schema: false, diagnostic: "/entrypoint" }),
  caseOf("rejects-invalid-repository-source", repositoryDescriptor({
    source: { ...repositoryDescriptor().source, repository: "https://token@github.com/example/skills" },
  }), { runtime: false, schema: false, diagnostic: "/source/repository" }),
  caseOf("rejects-invalid-local-source", repositoryDescriptor({ source: { ...localSource, identity: "local:opaque" } }), { runtime: false, schema: false, diagnostic: "/source/identity" }),
  caseOf("rejects-invalid-customization-source", repositoryDescriptor({
    source: { ...customizationSource("semantic-overlay"), id: "file:///Users/alice/source" },
  }), { runtime: false, schema: false, diagnostic: "/source/id" }),
  caseOf("rejects-overlay-fork-fields", repositoryDescriptor({ fork: fork(false) }), { runtime: false, schema: false, diagnostic: "/fork" }),
  caseOf("rejects-unmaterialized-overlay-fork", repositoryDescriptor({
    type: "fork", source: customizationSource("semantic-overlay"), fork: fork(false),
  }), { runtime: false, schema: false, diagnostic: "/fork/materialization" }),
  caseOf("runtime-only-coexist-name", repositoryDescriptor({ name: "review" }), { runtime: false, schema: true, diagnostic: "/name" }, "coexistName"),
  caseOf("runtime-only-replace-name", repositoryDescriptor({
    activation: { mode: "replace", precedence: "customization-first" },
  }), { runtime: false, schema: true, diagnostic: "/name" }, "replaceName"),
  caseOf("runtime-only-coexist-precedence", repositoryDescriptor({
    activation: { mode: "coexist", precedence: "customization-first" },
  }), { runtime: false, schema: true, diagnostic: "/activation/precedence" }, "activationPrecedence"),
  caseOf("runtime-only-repository-normalization", repositoryDescriptor({
    source: { ...repositoryDescriptor().source, repository: "https://github.com/example/skills/" },
  }), { runtime: false, schema: true, diagnostic: "/source/repository" }, "repositoryCanonicalization"),
  caseOf("runtime-only-materialization-source-equality", repositoryDescriptor({
    type: "fork", source: customizationSource("semantic-overlay"),
    fork: { ...fork(true), materialization: { ...fork(true).materialization, source_effective_fingerprint: fingerprint("1") } },
  }), { runtime: false, schema: true, diagnostic: "/fork/materialization/source_effective_fingerprint" }, "materializationSource"),
  caseOf("runtime-only-materialization-snapshot-equality", repositoryDescriptor({
    type: "fork", source: customizationSource("semantic-overlay"),
    fork: { ...fork(true), materialization: { ...fork(true).materialization, snapshot_fingerprint: fingerprint("2") } },
  }), { runtime: false, schema: true, diagnostic: "/fork/materialization/snapshot_fingerprint" }, "materializationSnapshot"),
]);
