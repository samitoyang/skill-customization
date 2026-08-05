import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relative) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

for (const skillName of ["skill-overlay", "skill-fork"]) {
  test(`${skillName} is concise and has decision-focused evals`, async () => {
    const markdown = await read(`skills/${skillName}/SKILL.md`);
    const packageJson = JSON.parse(await read("package.json"));
    assert.ok(markdown.split("\n").length < 80);
    assert.match(markdown, new RegExp(`^---\\nname: ${skillName}\\n`));
    assert.match(markdown, /license: MIT/);
    assert.match(markdown, /compatibility: Requires Node\.js 18\+/);
    assert.match(markdown, new RegExp(`skill-customization@${packageJson.version}`));
    assert.match(markdown, /description: Create or maintain/);
    assert.match(markdown, /indirect or explicit/);
    assert.match(markdown, /existing/);
    assert.match(markdown, /ambiguous/);
    assert.doesNotMatch(markdown, /\.\.\//);
    const steps = markdown.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.ok(steps.length >= 4);
    assert.ok(steps.every((line) => line.includes("**Gate:**")));
    assert.match(
      markdown,
      /Treat the source as read-only; write inside the (?:customization|fork) directory\./,
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
    for (const concept of ["upstream", "source", "separate", "same", `$${skillName}`]) {
      assert.ok(prompts.includes(concept), `evals should cover ${concept}`);
    }
    assert.ok(prompts.includes("existing"));
    const expectations = evals.evals
      .flatMap((item) => item.expectations)
      .join(" ")
      .toLowerCase();
    for (const decision of ["overlay", "fork", "companion", "replace"]) {
      assert.ok(expectations.includes(decision), `evals should distinguish ${decision}`);
    }
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
    const installed = markdown.indexOf("skill-customization --version");
    const fallback = markdown.indexOf("npx --yes skill-customization@");
    assert.ok(installed >= 0 && fallback > installed, "installed helper must be tried first");
    assert.match(markdown, /reports `0\.1\.0`/);
    assert.match(markdown, /Otherwise explain that `npx` will download or cache/);
    assert.match(markdown, /ask permission\. After approval, run/);
    assert.match(markdown, /permission is declined.*stop/);
    assert.match(markdown, /Node\/npm is unavailable.*stop/);
    assert.match(markdown, /optional manual setup/);
  }
});

test("README is skills-first and documents all and selective installation", async () => {
  const markdown = await read("README.md");
  assert.match(markdown, /I built Skill Customization/);
  assert.match(markdown, /npx skills@latest add samitoyang\/skill-customization\n/);
  assert.match(markdown, /--skill skill-overlay/);
  assert.match(markdown, /--skill skill-fork/);
  assert.match(markdown, /--global/);
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
