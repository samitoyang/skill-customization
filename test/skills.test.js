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

test("README combines public workflow design with contract-compatible helper behavior", async () => {
  const markdown = await read("README.md");
  assert.match(markdown, /^# 🛠️ Skill Customization/);
  assert.match(markdown, /provides a rock-solid, production-grade layer/);
  assert.match(markdown, /## ⚠️ Core Problems/);
  assert.match(markdown, /Update-managed source skills can overwrite direct tweaks/);
  assert.match(markdown, /read-only sources cannot be edited in place/);
  assert.match(markdown, /## 🎛️ Customization Models/);
  assert.match(markdown, /\| Model \| Desired outcome \| Architectural behavior \|/);
  assert.match(markdown, /\| Mode \| Naming \| Behavior \|/);
  assert.match(markdown, /npx skills@latest add samitoyang\/skill-customization\n/);
  assert.match(markdown, /--skill skill-overlay/);
  assert.match(markdown, /--skill skill-fork/);
  assert.doesNotMatch(markdown, /npx skills@[^\n]*--global/);
  assert.doesNotMatch(markdown, /Reported pain points and evidence/);
  assert.doesNotMatch(markdown, /github\.com\/(?:anthropics\/skills\/discussions|vercel-labs\/skills\/issues)/);
  assert.match(markdown, /\/skill-overlay customize/);
  assert.match(markdown, /\/skill-fork make/);
  assert.doesNotMatch(markdown, /\$skill-(?:overlay|fork)/);
  assert.match(markdown, /Both skills retain model discovery and explicit user invocation/);
  for (const managerLink of [
    "[skills](https://github.com/vercel-labs/skills)",
    "[asm](https://github.com/luongnv89/asm)",
    "[Skills Manager](https://github.com/xingkongliang/skills-manager)",
    "[skillsmgr](https://github.com/jtianling/skills-manager)",
  ]) {
    assert.ok(markdown.includes(managerLink));
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
  for (const host of ["Codex", "Claude Code", "GitHub Copilot", "Gemini CLI"]) {
    assert.ok(markdown.includes(host));
  }
  assert.match(markdown, /does not imply that every host loads or executes skills identically/);
  assert.match(markdown, /## 🧭 Customization Workflow/);
  assert.match(markdown, /```mermaid/);
  assert.match(markdown, /model-facing workflows/);
  assert.match(markdown, /deterministic engine/);
  assert.match(markdown, /skill name, repository, or path/i);
  assert.match(markdown, /### 📋 Intake and Confirmed Brief/);
  assert.match(markdown, /Helper-assisted discovery may be used during intake/);
  assert.match(markdown, /before the first binding/);
  assert.match(markdown, /same-name replacement requires separate confirmation/);
  for (const briefInput of [
    "Skill name, repository, or path",
    "Behavior and completion criteria",
    "Updates or independence",
    "Name and activation",
    "Workspace context",
    "License and provenance",
    "Helper permission",
  ]) {
    assert.ok(markdown.includes(briefInput), `README should cover ${briefInput}`);
  }
  assert.match(markdown, /one brief confirms the complete customization boundary/);
  assert.doesNotMatch(markdown, /## 🔌 Helper Compatibility/);
  assert.doesNotMatch(markdown, /skill-customization supports 1/);
  assert.match(markdown, /\[Helper contract 1\]\(docs\/helper-contract-1\.md\)/);
  assert.equal(markdown.match(/Helper contract 1/g)?.length, 1);
  assert.match(markdown, /\| Boundary \| Guarantee \|/);
  assert.match(markdown, /## 🤝 Contributing & License/);
  assert.match(markdown, /Skill Customization is available under the \[MIT License\]\(LICENSE\)/);
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
