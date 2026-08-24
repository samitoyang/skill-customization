import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DESCRIPTOR_INVARIANTS,
  DESCRIPTOR_SCHEMA_GAPS,
} from "../src/descriptor-invariants.js";
import { DESCRIPTOR_PARITY_CORPUS } from "./support/descriptor-parity-corpus.js";

function sorted(values) {
  return [...values].sort();
}

function assertObjectInvariant(schema, invariant, label) {
  assert.deepEqual(
    sorted(Object.keys(schema.properties ?? {})),
    sorted(invariant.allowed),
    `${label}: schema properties drifted`,
  );
  assert.deepEqual(
    sorted(schema.required ?? []),
    sorted(invariant.required),
    `${label}: schema required fields drifted`,
  );
}

function assertDeeplyFrozen(value, label, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${label} must be deeply frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeeplyFrozen(child, `${label}.${key}`, seen);
  }
}

function assertRequiredField(value, field, label) {
  assert.ok(value?.includes(field), `${label} must require ${field}`);
}

test("Descriptor invariant catalog is deterministic and deeply immutable", () => {
  assert.equal(DESCRIPTOR_INVARIANTS.version, 1);
  assertDeeplyFrozen(DESCRIPTOR_INVARIANTS, "DESCRIPTOR_INVARIANTS");
  assert.deepEqual(
    DESCRIPTOR_SCHEMA_GAPS,
    DESCRIPTOR_INVARIANTS.runtimeOnly.schemaGaps,
  );

  const corpusGaps = new Set(
    DESCRIPTOR_PARITY_CORPUS.map(({ gap }) => gap).filter(Boolean),
  );
  assert.deepEqual(
    sorted(corpusGaps),
    sorted(Object.keys(DESCRIPTOR_SCHEMA_GAPS)),
    "every runtime-only schema gap must be represented by the parity corpus",
  );
});

test("exported Descriptor schema is mechanically audited against the catalog", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../customization.schema.json", import.meta.url), "utf8"),
  );
  const { fields, patterns, values, relationships } = DESCRIPTOR_INVARIANTS;

  assertObjectInvariant(schema, fields.topLevel, "top level");
  assert.deepEqual(schema.required, fields.topLevel.required);
  assert.equal(schema.properties.schema_version.const, values.schemaVersion);
  assert.equal(schema.properties.$schema.$ref, "#/$defs/nonMachinePathString");
  assert.equal(schema.properties.id.$ref, "#/$defs/stableId");
  assert.equal(schema.properties.type.$ref, "#/$defs/customizationType");
  assert.equal(schema.properties.name.$ref, "#/$defs/skillName");
  assert.equal(schema.properties.entrypoint.$ref, "#/$defs/runtimePath");
  assert.equal(schema.properties.customization.$ref, "#/$defs/runtimePath");
  assert.equal(schema.properties.license.$ref, "#/$defs/license");
  assert.equal(schema.properties.dependencies.uniqueItems, values.dependenciesUnique);
  assert.equal(schema.properties.dependencies.items.$ref, "#/$defs/skillName");
  assert.equal(schema.properties.owned_payload.$ref, "#/$defs/ownedPayload");
  assert.equal(schema.properties.activation.$ref, "#/$defs/activation");
  assert.equal(schema.properties.fork.$ref, "#/$defs/fork");
  assert.deepEqual(
    schema.properties.source.oneOf.map(({ $ref }) => $ref),
    values.sourceKinds.map((kind) => `#/$defs/${kind}Source`),
  );

  for (const [kind, invariant] of Object.entries(fields.source.variants)) {
    const definition = schema.$defs[`${kind}Source`];
    assertObjectInvariant(definition, invariant, `${kind} source`);
    assert.equal(definition.properties.kind.const, kind);
    assert.equal(definition.properties.skill_name.$ref, "#/$defs/skillName");
    assert.equal(definition.properties.license.$ref, "#/$defs/license");
    assert.equal(definition.properties.effective_fingerprint.$ref, "#/$defs/fingerprint");
    if (kind === "repository") {
      assert.equal(definition.properties.upstream_path.$ref, "#/$defs/relativePath");
      assert.equal(
        definition.properties.review.properties.revision.$ref,
        "#/$defs/nonBlankPortableString",
      );
    }
    if (kind === "customization") {
      assert.equal(definition.properties.id.$ref, "#/$defs/stableId");
      assert.equal(definition.properties.type.$ref, "#/$defs/customizationType");
    }
  }
  assertObjectInvariant(
    schema.$defs.repositorySource.properties.review,
    fields.review,
    "repository review",
  );
  assert.equal(schema.$defs.license.$ref, "#/$defs/nonBlankPortableString");
  assertObjectInvariant(schema.$defs.ownedPayload, fields.ownedPayload, "owned payload");
  assert.equal(
    schema.$defs.ownedPayload.properties.reviewed_fingerprint.$ref,
    "#/$defs/fingerprint",
  );
  assertObjectInvariant(schema.$defs.activation, fields.activation, "activation");
  assertObjectInvariant(schema.$defs.fork, fields.fork, "fork");
  assertObjectInvariant(schema.$defs.materialization, fields.materialization, "materialization");
  assert.equal(schema.$defs.fork.properties.snapshot.$ref, "#/$defs/provenancePath");
  assert.equal(schema.$defs.fork.properties.diff.$ref, "#/$defs/provenancePath");
  assert.equal(
    schema.$defs.fork.properties.snapshot_fingerprint.$ref,
    "#/$defs/fingerprint",
  );
  assert.equal(
    schema.$defs.fork.properties.diff_fingerprint.$ref,
    "#/$defs/fingerprint",
  );
  assert.equal(
    schema.$defs.materialization.properties.source_effective_fingerprint.$ref,
    "#/$defs/fingerprint",
  );
  assert.equal(
    schema.$defs.materialization.properties.snapshot_fingerprint.$ref,
    "#/$defs/fingerprint",
  );
  assert.equal(
    schema.$defs.materialization.properties.reviewed_at.$ref,
    "#/$defs/nonBlankPortableString",
  );
  assert.equal(
    schema.$defs.materialization.properties.evidence.$ref,
    "#/$defs/nonBlankPortableString",
  );

  assert.equal(schema.$defs.skillName.pattern, patterns.skillName.source);
  assert.equal(schema.$defs.skillName.maxLength, patterns.skillName.maxLength);
  assert.equal(schema.$defs.stableId.pattern, patterns.stableId.source);
  assert.equal(schema.$defs.fingerprint.pattern, patterns.fingerprint.source);
  assert.equal(schema.$defs.localSource.properties.identity.pattern, patterns.localIdentity.source);
  assert.equal(
    schema.$defs.repositorySource.properties.repository.pattern,
    patterns.repositoryUrl.source,
  );
  assert.equal(schema.$defs.relativePath.pattern, patterns.relativePath.source);
  assert.equal(
    schema.$defs.provenancePath.allOf.find(({ pattern }) => pattern)?.pattern,
    patterns.provenancePath.source,
  );
  assert.equal(
    schema.$defs.nonBlankPortableString.allOf.find(({ pattern }) => pattern)?.pattern,
    patterns.nonBlank.source,
  );
  assert.deepEqual(
    schema.$defs.nonMachinePathString.allOf.map(({ not }) => not.pattern),
    patterns.nonMachinePath,
  );
  const runtimePathExclusion = schema.$defs.runtimePath.allOf.find(({ not }) => not?.pattern);
  assert.equal(schema.$defs.runtimePath.allOf[0].$ref, "#/$defs/relativePath");
  assert.equal(runtimePathExclusion?.not.pattern, patterns.runtimePathExclusion.source);

  assert.deepEqual(schema.$defs.customizationType.enum, values.customizationTypes);
  assert.deepEqual(schema.$defs.activation.properties.mode.enum, values.activationModes);
  assert.equal(
    schema.$defs.activation.properties.precedence.const,
    values.activationPrecedence,
  );

  const forkPresenceRelationship = relationships.fork;
  const forkPresence = schema.allOf.find(({ if: condition, then }) =>
    condition?.properties?.type?.const === forkPresenceRelationship.descriptorType
    && then?.required?.includes(forkPresenceRelationship.descriptorField));
  assert.ok(forkPresence, "schema must audit fork presence relationship");
  assertRequiredField(
    forkPresence.if.required,
    "type",
    "fork presence condition",
  );
  assertRequiredField(
    forkPresence.then.required,
    forkPresenceRelationship.descriptorField,
    "fork presence consequence",
  );
  assertRequiredField(
    forkPresence.else?.not?.required,
    forkPresenceRelationship.descriptorField,
    "non-fork presence exclusion",
  );

  const replaceRelationship = relationships.activation.replace;
  const replacePrecedence = schema.allOf.find(({ if: condition }) =>
    condition?.properties?.activation?.properties?.mode?.const === replaceRelationship.mode);
  assert.ok(replacePrecedence, "schema must audit replace precedence relationship");
  assertRequiredField(replacePrecedence.if.required, "activation", "replace precedence condition");
  assertRequiredField(
    replacePrecedence.then?.properties?.activation?.required,
    "precedence",
    "replace precedence consequence",
  );

  const materialization = schema.allOf.find(({ if: condition }) =>
    condition?.properties?.type?.const === forkPresenceRelationship.descriptorType
    && condition?.properties?.source?.properties?.kind?.const === forkPresenceRelationship.sourceKind
    && condition?.properties?.source?.properties?.type?.const === forkPresenceRelationship.sourceType);
  assert.ok(materialization, "schema must audit fork materialization relationship");
  assertRequiredField(materialization.if.required, "type", "materialization condition");
  assertRequiredField(materialization.if.required, "source", "materialization condition");
  assertRequiredField(
    materialization.then?.properties?.fork?.required,
    forkPresenceRelationship.materializationField,
    "materialization consequence",
  );
  assertRequiredField(
    materialization.else?.properties?.fork?.not?.required,
    forkPresenceRelationship.materializationField,
    "non-overlay materialization exclusion",
  );

  for (const field of forkPresenceRelationship.provenanceFields) {
    assert.equal(
      schema.$defs.fork.properties[field].$ref,
      "#/$defs/provenancePath",
      `fork ${field} must use the catalogued provenance path pattern`,
    );
  }
});
