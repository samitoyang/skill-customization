import assert from "node:assert/strict";
import test from "node:test";

import { renderDispatcher } from "../src/index.js";

test("renderDispatcher returns the canonical semantic-overlay dispatcher", () => {
  assert.equal(
    renderDispatcher("semantic-overlay", {
      name: "review-local-archive",
      description: "Review work and archive the result locally.",
      "argument-hint": "Repository or pull request to review",
      "disable-model-invocation": true,
    }),
    `---
name: "review-local-archive"
description: "Review work and archive the result locally."
argument-hint: "Repository or pull request to review"
disable-model-invocation: true
---

# Managed dispatcher

1. Run \`skill-customization supports 2\` and accept only a well-formed,
   compatible contract-2 result. Otherwise Call the Skill tool with
   \`skill-overlay\` once and execute no customization instructions.

2. Run \`skill-customization preflight
   <this-skill-directory>/customization.json --context <current-context>\`.
   For \`maintenance-required\`, Call the Skill tool with its returned handler.
   For malformed or failed preflight, Call the Skill tool with
   \`skill-overlay\`. Continue only for \`ready\` or
   \`ready-with-advisory\`: load the complete plan, then compose its workflow
   with deltas inner-to-outer so later deltas refine earlier instructions.

3. Report advisories first, then execute only the effective workflow.
`,
  );
});

test("renderDispatcher returns the canonical fork dispatcher", () => {
  assert.equal(
    renderDispatcher("fork", {
      name: "review-local",
      description: "Review work with an independent local workflow.",
    }),
    `---
name: "review-local"
description: "Review work with an independent local workflow."
---

# Managed dispatcher

1. Run \`skill-customization supports 2\` and accept only a well-formed,
   compatible contract-2 result. Otherwise Call the Skill tool with
   \`skill-fork\` once and execute no customization instructions.

2. Run \`skill-customization preflight
   <this-skill-directory>/customization.json --context <current-context>\`.
   For \`maintenance-required\`, Call the Skill tool with its returned handler.
   For malformed or failed preflight, Call the Skill tool with
   \`skill-fork\`. Continue only for \`ready\` or
   \`ready-with-advisory\`: load the complete plan, then compose its workflow
   with deltas inner-to-outer so later deltas refine earlier instructions.

3. Report advisories first, then execute only the effective workflow.
`,
  );
});

test("renderDispatcher serializes approved metadata in canonical order", () => {
  const dispatcher = renderDispatcher("fork", {
    "user-invocable": false,
    "disable-model-invocation": true,
    "argument-hint": "Use a path: \"./review\"",
    "allowed-tools": "Read Bash(git:*)",
    metadata: { version: "1.0", author: "example-org" },
    compatibility: "Requires Node.js 18+",
    license: "MIT",
    description: "Review work: preserve upstream behavior.",
    name: "review-local",
  });

  assert.equal(
    dispatcher.slice(0, dispatcher.indexOf("# Managed dispatcher")),
    `---
name: "review-local"
description: "Review work: preserve upstream behavior."
license: "MIT"
compatibility: "Requires Node.js 18+"
metadata:
  "author": "example-org"
  "version": "1.0"
allowed-tools: "Read Bash(git:*)"
argument-hint: "Use a path: \\"./review\\""
disable-model-invocation: true
user-invocable: false
---

`,
  );
});

test("renderDispatcher rejects unapproved metadata fields", () => {
  for (const field of [
    "body",
    "maintenance-handler",
    "package-version",
    "source-instructions",
    "source-path",
    "context-policy",
  ]) {
    assert.throws(
      () => renderDispatcher("fork", {
        name: "review-local",
        description: "Review locally.",
        [field]: "unapproved",
      }),
      new RegExp(`metadata field ${field} is not approved`, "i"),
    );
  }
});

test("renderDispatcher rejects unsupported types and non-record metadata", () => {
  for (const customizationType of [
    "overlay",
    "companion",
    "constructor",
    "toString",
    "__proto__",
    "",
    1,
    {},
    Symbol("fork"),
    null,
  ]) {
    assert.throws(
      () => renderDispatcher(customizationType, {
        name: "review-local",
        description: "Review locally.",
      }),
      /unsupported customization type/i,
    );
  }
  for (const metadata of [null, [], "metadata", new Date()]) {
    assert.throws(
      () => renderDispatcher("fork", metadata),
      /metadata must be a plain object/i,
    );
  }
});

test("renderDispatcher requires name and description metadata", () => {
  assert.throws(
    () => renderDispatcher("fork", { description: "Review locally." }),
    /name is required/i,
  );
  assert.throws(
    () => renderDispatcher("fork", { name: "review-local" }),
    /description is required/i,
  );
});

test("renderDispatcher validates required metadata values", () => {
  for (const name of ["", "Review-Local", "-review", "review-", "review--local", "a".repeat(64)]) {
    assert.throws(
      () => renderDispatcher("fork", { name, description: "Review locally." }),
      /name must/i,
    );
  }
  for (const description of ["", "   ", "a".repeat(1025), false]) {
    assert.throws(
      () => renderDispatcher("fork", { name: "review-local", description }),
      /description must/i,
    );
  }
});

test("renderDispatcher validates optional approved metadata values", () => {
  const core = { name: "review-local", description: "Review locally." };
  for (const [field, value] of [
    ["license", false],
    ["compatibility", ""],
    ["compatibility", "a".repeat(501)],
    ["allowed-tools", []],
    ["argument-hint", ""],
    ["disable-model-invocation", "true"],
    ["user-invocable", 1],
  ]) {
    assert.throws(
      () => renderDispatcher("fork", { ...core, [field]: value }),
      new RegExp(`${field} must`, "i"),
    );
  }
  for (const metadata of [null, [], { author: 1 }, { "": "example" }]) {
    assert.throws(
      () => renderDispatcher("fork", { ...core, metadata }),
      /metadata must/i,
    );
  }
});

test("renderDispatcher preserves metadata as a string map", () => {
  const dispatcher = renderDispatcher("fork", {
    name: "review-local",
    description: "Review locally.",
    metadata: {},
  });
  assert.match(dispatcher, /^metadata: \{\}$/m);

  assert.throws(
    () => renderDispatcher("fork", {
      name: "review-local",
      description: "Review locally.",
      metadata: { [Symbol("author")]: "example" },
    }),
    /metadata must/i,
  );
});

test("renderDispatcher rejects frontmatter content injection", () => {
  const core = { name: "review-local", description: "Review locally." };
  for (const [field, value] of [
    ["description", "Review locally.\n---\n# injected"],
    ["license", "MIT\rbody: injected"],
    ["compatibility", "Node.js\u2028body: injected"],
    ["allowed-tools", "Read\tbody: injected"],
    ["argument-hint", "path\0body: injected"],
  ]) {
    assert.throws(
      () => renderDispatcher("fork", { ...core, [field]: value }),
      /line breaks or control characters/i,
    );
  }
  for (const metadata of [
    { "author\nbody": "example" },
    { author: "example\n---\n# injected" },
  ]) {
    assert.throws(
      () => renderDispatcher("fork", { ...core, metadata }),
      /line breaks or control characters/i,
    );
  }
});

test("renderDispatcher rejects duplicate reserved metadata fields", () => {
  const core = { name: "review-local", description: "Review locally." };
  for (const metadata of [
    { ...core, Name: "other-name" },
    { ...core, metadata: { name: "other-name" } },
  ]) {
    assert.throws(
      () => renderDispatcher("fork", metadata),
      /duplicates reserved field name/i,
    );
  }
});
