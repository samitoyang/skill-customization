import assert from "node:assert/strict";
import test from "node:test";

import {
  suggestCustomizationNames,
  validateCustomizationName,
  validateSkillName,
} from "../src/naming.js";

test("skill name validation owns the shared portable name invariant", () => {
  assert.deepEqual(validateSkillName("a".repeat(63)), []);
  assert.match(validateSkillName("a".repeat(64))[0], /shorter than 64/i);
  assert.match(validateSkillName("Review_Local")[0], /lowercase kebab-case/i);
});

test("coexist naming uses source plus outcome before scaffolding", () => {
  const names = suggestCustomizationNames({
    sourceName: "handoff",
    outcome: "local archive",
    inventory: ["local-archive-handoff"],
  });
  assert.equal(names[0], "handoff-local-archive");
  assert.ok(names.length >= 2 && names.length <= 3);
  assert.equal(names.includes("local-archive-handoff"), false);
});

test("naming still offers multiple choices for a one-word outcome with collisions", () => {
  const names = suggestCustomizationNames({
    sourceName: "handoff",
    outcome: "archive",
    inventory: ["handoff-archive"],
  });
  assert.ok(names.length >= 2 && names.length <= 3);
  assert.equal(names.includes("handoff-archive"), false);
  assert.ok(names.every((name) => name.includes("archive")));
});

test("naming fails explicitly when its meaningful candidates are exhausted", () => {
  assert.throws(
    () =>
      suggestCustomizationNames({
        sourceName: "handoff",
        outcome: "archive",
        inventory: [
          "handoff-archive",
          "archive-handoff",
          "handoff-archive-workflow",
          "handoff-archive-support",
          "archive-workflow-handoff",
        ],
      }),
    /fewer than two collision-free/i,
  );
});

test("name validation catches folder, inventory, suffix, and activation conflicts", () => {
  assert.deepEqual(
    validateCustomizationName({
      name: "handoff-local-archive",
      sourceName: "handoff",
      mode: "coexist",
      folderName: "handoff-local-archive",
      inventory: [],
    }),
    [],
  );
  const errors = validateCustomizationName({
    name: "handoff-overlay",
    sourceName: "handoff-overlay",
    mode: "coexist",
    folderName: "other",
    inventory: ["handoff-overlay"],
  });
  assert.ok(errors.some((message) => message.includes("-overlay")));
  assert.ok(errors.some((message) => message.includes("folder")));
  assert.ok(errors.some((message) => message.includes("inventory")));
  assert.ok(errors.some((message) => message.includes("coexist")));
});
