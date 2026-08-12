import assert from "node:assert/strict";
import test from "node:test";
import { isForbiddenPackagePath } from "../scripts/package-path-policy.js";

test("private package path components are rejected at every depth", () => {
  for (const file of [
    "AGENTS.md",
    "skills/skill-overlay/AGENTS.md",
    "src/.internal/notes.md",
    "src/nested/.github/workflows/ci.yml",
    "skills\\skill-fork\\CONTEXT.md",
    "bin/test/fixture.js",
  ]) {
    assert.equal(isForbiddenPackagePath(file), true, file);
  }

  for (const file of [
    "src/internal.js",
    "src/test-helper.js",
    "docs/agents.md",
    "skills/skill-overlay/references/context.md",
  ]) {
    assert.equal(isForbiddenPackagePath(file), false, file);
  }
});
