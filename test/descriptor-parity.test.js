import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateDescriptor } from "../src/descriptor.js";
import { DESCRIPTOR_SCHEMA_GAPS } from "../src/descriptor-invariants.js";
import {
  DESCRIPTOR_PARITY_CORPUS,
} from "./support/descriptor-parity-corpus.js";
import { matchesJsonSchema } from "./support/json-schema-validator.js";

test("portable Descriptor corpus records schema parity and explicit runtime-only gaps", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../customization.schema.json", import.meta.url), "utf8"),
  );
  const observedGaps = new Set();

  for (const entry of DESCRIPTOR_PARITY_CORPUS) {
    const diagnostics = validateDescriptor(entry.descriptor);
    const runtime = diagnostics.length === 0;
    const schemaResult = matchesJsonSchema(schema, schema, entry.descriptor);
    assert.equal(runtime, entry.expected.runtime, `${entry.name}: runtime result drifted`);
    assert.equal(schemaResult, entry.expected.schema, `${entry.name}: schema result drifted`);
    if (entry.expected.diagnostic) {
      assert.ok(
        diagnostics.some(({ path }) => path === entry.expected.diagnostic),
        `${entry.name}: expected runtime diagnostic ${entry.expected.diagnostic}`,
      );
    }
    if (entry.gap) observedGaps.add(entry.gap);
    else assert.equal(runtime, schemaResult, `${entry.name}: unexpected schema mismatch`);
  }

  assert.deepEqual(
    [...observedGaps].sort(),
    Object.keys(DESCRIPTOR_SCHEMA_GAPS).sort(),
    "every runtime-only schema gap must have a named corpus case",
  );
});
