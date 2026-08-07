import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relative) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

for (const skillName of ["skill-overlay", "skill-fork"]) {
  test(`${skillName} is concise and has decision-focused evals`, async () => {
    const markdown = await read(`skills/${skillName}/SKILL.md`);
    assert.ok(markdown.split("\n").length < 80);
    assert.match(markdown, new RegExp(`^---\\nname: ${skillName}\\n`));
    assert.match(markdown, /license: MIT/);
    assert.match(markdown, /compatibility: Requires Node\.js 18\+/);
    assert.match(markdown, /helper contract 1/);
    assert.match(markdown, /description: Create or maintain/);
    assert.match(markdown, /natural-language or explicit/);
    assert.match(markdown, /existing/);
    assert.match(markdown, /ambiguous/);
    assert.doesNotMatch(markdown, /disable-(?:model|user)-invocation/);
    assert.doesNotMatch(markdown, /\.\.\//);
    const steps = markdown.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.ok(steps.length >= 4);
    assert.ok(steps.every((line) => line.includes("**Gate:**")));
    assert.match(
      markdown,
      /Treat the source as read-only and write only inside the (?:customization|fork) or local state paths\./,
    );
    const evals = JSON.parse(await read(`skills/${skillName}/evals/evals.json`));
    assert.equal(evals.skill_name, skillName);
    assert.equal(new Set(evals.evals.map(({ id }) => id)).size, evals.evals.length);
    for (const item of evals.evals) {
      assert.equal(typeof item.prompt, "string");
      assert.equal(typeof item.expected_output, "string");
      assert.ok(Array.isArray(item.expectations) && item.expectations.length > 0);
    }
    const prompts = evals.evals.map(({ prompt }) => prompt).join(" ").toLowerCase();
    for (const concept of ["upstream", "source", "same", `/${skillName}`]) {
      assert.ok(prompts.includes(concept), `evals should cover ${concept}`);
    }
    assert.ok(prompts.includes("existing"));
    assert.ok(evals.evals.some(({ prompt }) => prompt.trim() === `/${skillName}`));
    assert.ok(evals.evals.some(({ prompt }) => prompt.includes("/workspace/")));
    assert.ok(evals.evals.some(({ prompt }) => !prompt.includes(`/${skillName}`)));
    const expectations = evals.evals
      .flatMap((item) => item.expectations)
      .join(" ")
      .toLowerCase();
    for (const decision of ["overlay", "fork", "companion", "replace"]) {
      assert.ok(expectations.includes(decision), `evals should distinguish ${decision}`);
    }
    assert.match(expectations, /agent-writing or skill-creation/);
    assert.match(expectations, /waits for explicit routing confirmation/);
    assert.match(expectations, /inventory/);
  });
}

test("published skills are independently installable", async () => {
  for (const skillName of ["skill-overlay", "skill-fork"]) {
    const markdown = await read(`skills/${skillName}/SKILL.md`);
    const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
      ([, target]) => target,
    );
    for (const target of links) {
      if (/^https:\/\//.test(target)) continue;
      assert.ok(!target.startsWith("/") && !target.split("/").includes(".."));
      await access(new URL(`../skills/${skillName}/${target}`, import.meta.url));
    }
  }
});

test("skill helper policy covers installed, npx, declined, incompatible, and missing prerequisites", async () => {
  for (const skillName of ["skill-overlay", "skill-fork"]) {
    const markdown = await read(`skills/${skillName}/SKILL.md`);
    const installed = markdown.indexOf("skill-customization supports 1");
    const fallback = markdown.indexOf("npx --yes skill-customization@latest supports 1");
    assert.ok(installed >= 0 && fallback > installed, "installed helper must be tried first");
    assert.match(markdown, /compatible: true/);
    assert.match(markdown, /non-empty `package_version`/);
    assert.match(markdown, /may download `skill-customization@latest` and reuse npm's cache/);
    assert.match(markdown, /obtain permission\. After approval, run/);
    assert.match(markdown, /skill-customization@<package_version> <command>/);
    assert.match(markdown, /permission is declined/);
    assert.match(markdown, /Node\/npm is missing/);
    assert.match(markdown, /contract 1 is unsupported/);
    assert.doesNotMatch(markdown, /skill-customization@0\.1\.0/);
  }
});

test("README explains the user problem, evidence, intake, and contract compatibility", async () => {
  const markdown = await read("README.md");
  const introduction = markdown.split("## Reported pain points and evidence")[0];
  assert.doesNotMatch(introduction, /\bI\b|\bmy\b/i);
  for (const concept of [
    "read-only",
    "managed by an updater",
    "full-copy fork",
    "loses provenance",
    "name or trigger",
    "agent paths and skill managers",
    "upstream reconciliation",
  ]) {
    assert.ok(introduction.includes(concept), `introduction should cover ${concept}`);
  }
  assert.match(markdown, /## Reported pain points and evidence/);
  for (const link of [
    "https://github.com/anthropics/skills/discussions/380",
    "https://github.com/anthropics/skills/discussions/911",
    "https://github.com/anthropics/skills/discussions/166",
    "https://github.com/vercel-labs/skills/issues/810",
    "https://github.com/vercel-labs/skills/issues/283",
  ]) {
    assert.ok(markdown.includes(link));
  }
  assert.match(markdown, /npx skills@latest add samitoyang\/skill-customization\n/);
  assert.match(markdown, /--skill skill-overlay/);
  assert.match(markdown, /--skill skill-fork/);
  assert.match(markdown, /--global/);
  assert.match(markdown, /Natural-language requests are auto-selected/);
  assert.match(markdown, /\/skill-overlay customize/);
  assert.match(markdown, /\/skill-fork make/);
  assert.match(markdown, /Both skills retain model discovery and explicit user invocation/);
  for (const inputCase of [
    "Complete path and idea",
    "Skill name only",
    "Idea without a source",
    "Missing idea",
    "Empty invocation",
    "Existing customization",
    "Explicit model mismatch",
  ]) {
    assert.ok(markdown.includes(inputCase), `README should cover ${inputCase}`);
  }
  assert.match(markdown, /Node\.js 18 or newer, npm access, and helper contract 1 are required/);
  assert.match(markdown, /Routing, inventory, and intake can happen before the helper/);
  assert.ok(
    markdown.indexOf("After the brief is confirmed")
      < markdown.indexOf("npx --yes skill-customization@latest supports 1"),
  );
  assert.match(markdown, /asks permission/);
  assert.match(markdown, /reuse npm's cache/);
  assert.match(markdown, /optionally install the current helper globally/);
  assert.match(markdown, /original published skill text pinned `skill-customization@0\.1\.0`/);
  assert.match(markdown, /newer `@latest` helper can be used when `supports 1` succeeds/);
  assert.match(markdown, /Legacy copies of the exact-pinned skill text still cannot accept newer helpers/);
  for (const manager of [
    "Vercel Skills",
    "ASM",
    "xingkongliang Skills Manager",
    "jtianling skillsmgr",
  ]) {
    assert.ok(markdown.includes(manager));
  }
  for (const root of [
    ".agents/skills",
    ".claude/skills",
    ".github/skills",
    ".cursor/skills",
    ".windsurf/skills",
    "$CODEX_HOME/skills",
  ]) {
    assert.ok(markdown.includes(root));
  }
  assert.match(markdown, /does not imply that every agent loads or executes skills identically/);
});

test("public documentation pointers resolve", async () => {
  const documents = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/cli.md",
    "docs/helper-contract-1.md",
    "docs/descriptor-v1.md",
    "docs/discovery-and-bindings.md",
    "docs/library.md",
    "docs/reconciliation.md",
  ];
  for (const document of documents) {
    const markdown = await read(document);
    const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(([, target]) => target);
    for (const target of links) {
      if (/^(?:https?:|#)/.test(target)) continue;
      await access(new URL(`../${document}/../${target}`, import.meta.url));
    }
  }
});

test("the package uses a public-document allowlist and verifies its Node 18 floor in CI", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const publicDocs = packageJson.files.filter((file) => file.startsWith("docs/"));
  assert.deepEqual(publicDocs, [
    "docs/cli.md",
    "docs/helper-contract-1.md",
    "docs/descriptor-v1.md",
    "docs/discovery-and-bindings.md",
    "docs/library.md",
    "docs/reconciliation.md",
  ]);
  assert.ok(publicDocs.every((file) => !file.includes("*")));
  assert.equal(packageJson.engines.node, ">=18");
  assert.equal(packageJson.publishConfig.access, "public");
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/samitoyang/skill-customization.git",
  );
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /node:\s*\[18, 22, 24\]/);
  assert.match(workflow, /npm pack --dry-run/);
});
