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
    assert.match(markdown, /compatibility: Requires Node\.js 22\.14\+/);
    assert.match(markdown, /npm only for the on-demand fallback/);
    assert.doesNotMatch(markdown, /Node\.js 22\.14\+, npm access/);
    assert.match(markdown, /helper contract 2/);
    assert.match(markdown, /thin dispatchers/);
    assert.match(markdown, /skill-customization preflight/);
    assert.match(markdown, /ready-with-advisory/);
    assert.match(markdown, /accept-maintenance/);
    assert.match(markdown, /never runs unchecked/);
    assert.match(markdown, /description: Create or maintain/);
    assert.match(markdown, /natural-language (?:overlay|fork) requests/);
    assert.doesNotMatch(markdown, /natural-language or explicit/);
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
    assert.match(markdown, /preflight reruns `ready` or `ready-with-advisory`/);
    const evals = JSON.parse(await read(`skills/${skillName}/evals/evals.json`));
    const intake = await read(`skills/${skillName}/references/intake.md`);
    assert.match(markdown, /skill-customization render-dispatcher/);
    assert.match(markdown, /approved frontmatter/);
    assert.match(markdown, /write its output to `SKILL\.md` unchanged/);
    assert.match(
      markdown,
      /Never compose, paraphrase, extend, or repair the dispatcher body/,
    );
    assert.match(intake, /\[ADR 0001\]\(https:\/\/github\.com\/samitoyang\/skill-customization\/blob\/main\/docs\/adr\/0001-managed-recursive-runtime\.md\)/);
    assert.match(intake, /\*\*Approved frontmatter:\*\*/);
    assert.match(intake, /\*\*Helper fallback:\*\*/);
    assert.match(
      intake,
      /Never pass fallback permission, helper commands, package versions, source instructions, paths, or context policy to the renderer/,
    );
    assert.match(
      intake,
      /Default a new workspace customization to `\.agents\/skills\/<name>\/`/,
    );
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
    for (const forbidden of [
      "freehand dispatcher body",
      "pinned helper version",
      "fallback command",
      "source workflow instructions",
      "concrete source path",
      "context-specific dispatcher policy",
    ]) {
      assert.ok(
        expectations.includes(forbidden),
        `evals should reject ${forbidden}`,
      );
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

test("the default project customization root remains trackable", async () => {
  const ignore = await read(".gitignore");
  assert.doesNotMatch(ignore, /^\.agents\/?\s*$/m);
});

test("skill helper policy covers installed, linked, registry, and stopped paths", async () => {
  for (const skillName of ["skill-overlay", "skill-fork"]) {
    const markdown = await read(`skills/${skillName}/SKILL.md`);
    const installed = markdown.indexOf("skill-customization supports 2");
    const linked = markdown.indexOf(
      "npx --yes --package <checkout-root> skill-customization supports 2",
    );
    const linkedPermission = markdown.indexOf(
      "obtain permission to use it for this run",
    );
    const registry = markdown.indexOf("npx --yes skill-customization@latest supports 2");
    assert.ok(
      installed >= 0
        && linkedPermission > installed
        && linked > linkedPermission
        && registry > linked,
      "helper selection must try installed, approved linked, then approved registry candidates",
    );
    assert.match(markdown, /compatible: true/);
    assert.match(markdown, /non-empty `package_version`/);
    assert.match(markdown, /bounded Git ancestors/);
    assert.match(
      markdown,
      /`origin` URL normalizes to `https:\/\/github\.com\/samitoyang\/skill-customization`/,
    );
    assert.match(markdown, /root package is named `skill-customization`/);
    assert.match(markdown, /local candidate, not authenticated code/);
    assert.match(markdown, /execute its local code without downloading it/);
    assert.match(markdown, /before each remaining command/);
    assert.match(markdown, /may download `skill-customization@latest` and reuse npm's cache/);
    assert.match(markdown, /obtain permission\. After approval, run/);
    assert.match(markdown, /skill-customization@<package_version> <command>/);
    assert.match(markdown, /permission is declined/);
    assert.match(markdown, /Node\.js is missing/);
    assert.match(markdown, /fallback requires npm/);
    assert.match(markdown, /contract 2 is unsupported/);
    assert.doesNotMatch(markdown, /skill-customization@0\.1\.0/);
  }
});

test("fork maintenance guidance preserves reviewed materialization and advisory tracking", async () => {
  const markdown = await read("skills/skill-fork/SKILL.md");
  const intake = await read("skills/skill-fork/references/intake.md");
  assert.match(
    markdown,
    /both `--reviewed-at` and `--evidence` when either materialization fingerprint changes/,
  );
  for (const document of [markdown, intake]) {
    assert.match(document, /unreadable or invalid optional tracking state/);
    assert.match(document, /snapshot directory/);
  }
  assert.doesNotMatch(intake, /proposed delta/);
  const evals = JSON.parse(await read("skills/skill-fork/evals/evals.json"));
  assert.equal(evals.evals.find(({ id }) => id === 6)?.prompt.startsWith("Run "), true);
  assert.match(
    evals.evals.find(({ id }) => id === 14)?.expected_output ?? "",
    /without overlay-chain materialization/,
  );
});

test("contract fixture dispatcher negotiates the helper and stops safely", async () => {
  const dispatcher = await read(
    "test/fixtures/contract-v1/review-local-archive/SKILL.md",
  );
  assert.match(dispatcher, /description: Review work and archive the result locally\./);
  assert.doesNotMatch(dispatcher, /description:.*preflight/);
  assert.match(dispatcher, /skill-customization supports 1/);
  assert.match(dispatcher, /accepting only a compatible contract-1 result/);
  assert.match(
    dispatcher,
    /unavailable, incompatible, or malformed, delegate to `skill-overlay` and do not execute the customization/,
  );
  assert.match(dispatcher, /`ready` or `ready-with-advisory`/);
  assert.match(
    dispatcher,
    /delegate `maintenance-required` to its maintenance handler/,
  );
  assert.doesNotMatch(dispatcher, /supports 2|render-dispatcher/);
});

test("public maintenance references describe explicit fingerprint updates", async () => {
  const [cli, library, contract, descriptor] = await Promise.all([
    read("docs/cli.md"),
    read("docs/library.md"),
    read("docs/helper-contract-1.md"),
    read("docs/descriptor-v1.md"),
  ]);
  for (const document of [cli, library, contract]) {
    assert.match(document, /source effective fingerprint only when explicitly supplied/i);
  }
  for (const document of [cli, library]) {
    assert.match(
      document,
      /both (?:`--reviewed-at` and `--evidence`|`reviewedAt` and `evidence`) are required when either materialization fingerprint changes/i,
    );
  }
  assert.match(descriptor, /snapshot directory/);
  assert.match(descriptor, /runtime selectors must name files inside that reviewed payload/i);
  assert.doesNotMatch(descriptor, /full-source snapshot (?:file|may be a file)/i);
  assert.match(contract, /both fresh review time and evidence/i);
  assert.match(contract, /local identities derived from `SKILL\.md` bytes/i);
  for (const document of [cli, library, contract, descriptor]) {
    assert.match(document, /symlink/i);
  }
  assert.match(cli, /maintenance lock is canonically contained/i);
  assert.match(contract, /canonically contain its lock/i);
});

test("README combines public workflow design with contract-compatible helper behavior", async () => {
  const markdown = await read("README.md");
  assert.match(markdown, /^# 🛠️ Skill Customization/);
  const introduction = markdown.split("\n\n")[1];
  assert.match(introduction, /^Skill Customization provides/);
  assert.match(introduction, /keeping custom workflows aligned with improvements from their original sources/);
  assert.match(introduction, /tracks where each skill came from/);
  assert.match(introduction, /prevents future updates from silently overwriting or breaking customized behavior/);
  assert.doesNotMatch(introduction, /(?:provenance|overlay|fork|:)/i);
  assert.doesNotMatch(markdown, /\b(?:you|your)\b/i);
  assert.match(markdown, /## ⚠️ Core Problems/);
  assert.match(markdown, /Update-managed source skills can overwrite direct tweaks/);
  assert.match(markdown, /read-only sources cannot be edited in place/);
  assert.match(markdown, /portable descriptor state the expected source identity and fingerprint/);
  assert.match(markdown, /bindings\.json\s+# Confirmed path for this context/);
  assert.match(markdown, /customization\.json\s+# Descriptor: portable identity \+ review/);
  assert.match(markdown, /customization\.json\s+# Descriptor: portable identity \+ provenance/);
  assert.match(markdown, /customization\.json\s+# Descriptor: portable source requirements/);
  assert.match(markdown, /CUSTOMIZATION\.md\s+# Complete independent workflow/);
  assert.match(markdown, /source snapshot directory/);
  assert.match(markdown, /symlink-free fingerprinted target tree/);
  assert.match(markdown, /maintenance locks are canonically contained/);
  assert.match(markdown, /runtime selectors stay inside the reviewed owned payload/);
  assert.match(markdown, /## 🎛️ Customization Models/);
  assert.match(markdown, /Customization models describe the runtime relationship between a skill and its source/);
  assert.match(markdown, /\| Model \| Source relationship \| Runtime behavior \|/);
  assert.match(markdown, /verified overlay, or verified fork/);
  assert.match(markdown, /no live runtime source required/);
  assert.match(markdown, /\| Mode \| Naming \| Behavior \|/);
  assert.match(markdown, /npx skills@latest add samitoyang\/skill-customization\n/);
  assert.doesNotMatch(markdown, /npx skills@[^\n]*--global/);
  assert.doesNotMatch(
    markdown,
    /Natural-language requests can select either skill automatically/,
  );
  assert.match(markdown, /git clone https:\/\/github\.com\/samitoyang\/skill-customization\.git/);
  assert.match(markdown, /symlink the complete skill directories/);
  assert.doesNotMatch(markdown, /copy or symlink the complete skill directories/);
  assert.match(
    markdown,
    /> \[!NOTE\]\n> A symlinked checkout can reuse its local helper after approval\./,
  );
  assert.match(
    markdown,
    /If the skills are just copied to a skill root, an installed helper or the approved registry fallback is still needed/,
  );
  assert.doesNotMatch(markdown, /recent Claude Code releases/);
  assert.doesNotMatch(markdown, /repository-verified symlinked checkout/);
  assert.match(markdown, /Approval when selecting an on-demand helper covers subsequent helper commands/);
  assert.match(markdown, /while its recorded identity and state remain unchanged/);
  assert.match(markdown, /npm install --global skill-customization@latest/);
  assert.match(markdown, /Optionally pre-install the helper/);
  assert.match(markdown, /Compatibility is checked before use/);
  assert.doesNotMatch(markdown, /Reported pain points and evidence/);
  assert.doesNotMatch(markdown, /github\.com\/(?:anthropics\/skills\/discussions|vercel-labs\/skills\/issues)/);
  assert.match(markdown, /## 🌐 Ecosystem Compatibility/);
  assert.match(markdown, /### Hosts and roots/);
  assert.match(markdown, /### Skill managers/);
  assert.ok(markdown.indexOf("## 📥 Installation") < markdown.indexOf("## 🌐 Ecosystem Compatibility"));
  assert.ok(markdown.indexOf("## 🌐 Ecosystem Compatibility") < markdown.indexOf("## 💬 Usage"));
  assert.match(markdown, /```text\n\/skill-overlay\n\/skill-fork\n```/);
  assert.match(markdown, /\/skill-overlay customize/);
  assert.match(markdown, /\/skill-fork make/);
  assert.doesNotMatch(markdown, /\$skill-(?:overlay|fork)/);
  assert.match(markdown, /Explicit invocation and automatic model selection enter the same creation process/);
  assert.ok(markdown.indexOf("### Explicit Skill Invocations") < markdown.indexOf("### Natural Language Prompts"));
  assert.match(markdown, /### After Creation/);
  assert.match(markdown, /\*\*Destination:\*\* New workspace customizations use `\.agents\/skills\/<name>\/` by default/);
  assert.match(markdown, /a compatible host-specific project root or personal skill root may be selected instead/);
  assert.match(markdown, /\*\*Relocation:\*\* Move the entire customization directory/);
  assert.match(markdown, /different workspace, an overlay requires source confirmation before running; a fork continues independently/);
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
  assert.match(markdown, /## 📋 Creation Workflow/);
  assert.match(markdown, /## 🧭 Runtime Workflow/);
  assert.ok(markdown.indexOf("## 📋 Creation Workflow") < markdown.indexOf("## 🧭 Runtime Workflow"));
  assert.match(markdown, /```mermaid/);
  assert.ok(markdown.indexOf("```mermaid") < markdown.indexOf("| Graph component | Artifact | Responsibility |"));
  assert.match(markdown, /subgraph P\["Preflight"\]/);
  assert.match(markdown, /Dispatcher file<br\/>\(SKILL\.md\)/);
  assert.match(markdown, /Preflight helper<br\/>\(skill-customization package\)/);
  assert.match(markdown, /Descriptor file<br\/>\(customization\.json\)/);
  assert.match(markdown, /source: ordinary skill \/ overlay \/ fork/);
  assert.match(markdown, /B -->\|"reads"\| G/);
  assert.match(markdown, /B -->\|"uses when required"\| H/);
  assert.match(markdown, /Maintenance skills<br\/>\(skill-overlay \/ skill-fork\)/);
  assert.match(markdown, /Checked execution plan<br\/>\(workflow \+ ordered deltas\)/);
  assert.match(markdown, /Load the complete plan<br\/>before any workflow action/);
  assert.match(markdown, /Compose one effective workflow<br\/>deltas refine inner to outer/);
  for (const component of [
    "Dispatcher file",
    "Descriptor file",
    "Local binding state",
    "Preflight helper",
    "Runtime instructions",
    "Maintenance skills",
  ]) {
    assert.match(markdown, new RegExp(`\\| ${component} \\|`));
  }
  assert.match(markdown, /Source `SKILL\.md` and customization `CUSTOMIZATION\.md` files/);
  assert.match(markdown, /Stores portable identity, source requirements, and reviewed fingerprints/);
  assert.match(markdown, /compose the base or fork workflow with inner-to-outer deltas before any action/);
  assert.match(markdown, /ready-with-advisory/);
  assert.match(markdown, /maintenance-required/);
  assert.match(markdown, /without invoking a maintenance skill/);
  assert.doesNotMatch(markdown, /One maintenance handler/);
  assert.doesNotMatch(markdown, /### Managed preflight/);
  assert.doesNotMatch(markdown, /\[preflight contract\]/);
  assert.match(markdown, /skill name, repository, or path/i);
  assert.match(markdown, /Helper-assisted discovery inventories available evidence/);
  assert.match(markdown, /Same-name replacement requires separate confirmation/);
  for (const briefInput of [
    "Skill name, repository, or path",
    "Behavior and completion criteria",
    "Updates or independence",
    "Name and activation",
    "Workspace context",
    "License and provenance",
    "Helper access",
  ]) {
    assert.ok(markdown.includes(briefInput), `README should cover ${briefInput}`);
  }
  assert.match(markdown, /Before artifacts are written or a binding is created/);
  assert.match(markdown, /one brief confirms the complete customization boundary/);
  assert.doesNotMatch(markdown, /## 🔌 Helper Compatibility/);
  assert.match(markdown, /\[Helper contract 2\]\(docs\/helper-contract-2\.md\)/);
  assert.match(markdown, /\[Helper contract 1\]\(docs\/helper-contract-1\.md\)/);
  assert.equal(markdown.match(/Helper contract 2/g)?.length, 1);
  assert.equal(markdown.match(/Helper contract 1/g)?.length, 1);
  assert.match(markdown, /\| Boundary \| Guarantee \|/);
  assert.match(markdown, /\| Helper execution \| Checkout metadata identifies but does not authenticate a local candidate/);
  assert.match(markdown, /covers subsequent commands only while its recorded identity and state remain unchanged/);
  assert.match(markdown, /local-code execution approval/);
  assert.doesNotMatch(markdown, /## 🤝 Contributing and License/);
});

test("public documentation pointers resolve", async () => {
  const documents = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/cli.md",
    "docs/helper-contract-1.md",
    "docs/helper-contract-2.md",
    "docs/descriptor-v1.md",
    "docs/discovery-and-bindings.md",
    "docs/library.md",
    "docs/reconciliation.md",
    "docs/agents/domain.md",
    "docs/agents/issue-tracker.md",
    "docs/agents/triage-labels.md",
    "docs/adr/0001-managed-recursive-runtime.md",
    "docs/adr/0002-bounded-plugin-provenance-discovery.md",
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

test("the package uses a public-document allowlist and verifies its Node 22.14 floor in CI", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const publicDocs = packageJson.files.filter((file) => file.startsWith("docs/"));
  assert.deepEqual(publicDocs, [
    "docs/cli.md",
    "docs/helper-contract-1.md",
    "docs/helper-contract-2.md",
    "docs/descriptor-v1.md",
    "docs/discovery-and-bindings.md",
    "docs/library.md",
    "docs/reconciliation.md",
    "docs/adr/0001-managed-recursive-runtime.md",
    "docs/adr/0002-bounded-plugin-provenance-discovery.md",
  ]);
  assert.ok(publicDocs.every((file) => !file.includes("*")));
  assert.equal(packageJson.engines.node, ">=22.14.0");
  assert.equal(packageJson.publishConfig.access, "public");
  assert.ok(packageJson.files.includes("CONTRIBUTING.md"));
  assert.ok(packageJson.files.includes("SECURITY.md"));
  assert.match(packageJson.scripts.verify, /npm run check:package/);
  assert.equal(packageJson.scripts.prepublishOnly, "npm run verify");
  const packageAudit = await read("scripts/check-package.js");
  for (const releaseFile of [
    "docs/adr/0001-managed-recursive-runtime.md",
    "src/maintenance.js",
    "src/owned-payload.js",
    "src/preflight.js",
  ]) {
    assert.ok(packageAudit.includes(`"${releaseFile}"`));
  }
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/samitoyang/skill-customization.git",
  );
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /node:\s*\["22\.14\.0", "24", "26"\]/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(await read("scripts/verify.js"), /Node\.js 22\.14 or newer/);
});

test("release automation uses Changesets with npm trusted publishing", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.scripts.changeset, "changeset");
  assert.equal(packageJson.scripts.release, "changeset publish");
  assert.match(
    packageJson.scripts["version-packages"],
    /^changeset version && npm install --package-lock-only/,
  );
  assert.ok(packageJson.devDependencies["@changesets/cli"]);
  assert.ok(packageJson.devDependencies["@changesets/changelog-github"]);

  const config = JSON.parse(await read(".changeset/config.json"));
  assert.equal(config.access, "public");
  assert.equal(config.baseBranch, "main");
  assert.deepEqual(config.changelog, [
    "@changesets/changelog-github",
    { repo: "samitoyang/skill-customization" },
  ]);

  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /package-manager-cache:\s*false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /changesets\/action\/select-mode@v2/);
  assert.match(workflow, /changesets\/action\/version@v2/);
  assert.match(workflow, /changesets\/action\/pack@v2/);
  assert.match(workflow, /changesets\/action\/publish@v2/);
  assert.equal(workflow.match(/id-token:\s*write/g)?.length, 1);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN/);
});
