import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverAmbientSkills } from "./support/discovery-modes.js";
import {
  CLAUDE_CODE_HOST_ADAPTER,
  PLUGIN_HOST_SPECIFICATIONS,
} from "../src/plugin-discovery.js";
import { checkProvenance } from "../src/provenance.js";

async function writeSkill(root, name, body = "fixture\n") {
  const skill = path.join(root, name);
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\n${body}`,
  );
  return skill;
}

test("Claude Code adapter emits registry and provenance compatible observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-adapter-"));
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const claudeHome = path.join(home, ".claude");
    const pluginRoot = path.join(
      claudeHome,
      "plugins",
      "cache",
      "official",
      "reviewer",
      "1.0.0",
    );
    const marketplace = path.join(
      claudeHome,
      "plugins",
      "marketplaces",
      "team",
    );
    const codexHome = path.join(home, ".codex");
    const codexPluginRoot = path.join(codexHome, "plugins", "codex-reviewer");
    await mkdir(cwd, { recursive: true });
    await writeSkill(path.join(pluginRoot, "skills"), "review");
    await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "reviewer",
        version: "1.0.0",
        repository: "https://github.com/example/reviewer",
      }),
    );
    await writeFile(
      path.join(claudeHome, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "reviewer@official": [{
            scope: "user",
            installPath: pluginRoot,
            version: "1.0.0",
          }],
        },
      }),
    );
    await writeFile(
      path.join(claudeHome, "plugins", "known_marketplaces.json"),
      "{malformed\n",
    );
    await writeSkill(path.join(marketplace, "plugins", "audit", "skills"), "audit");
    await mkdir(path.join(marketplace, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(marketplace, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "team",
        plugins: [{
          name: "audit",
          source: "./plugins/audit",
          repository: "https://github.com/example/audit",
        }],
      }),
    );
    await writeSkill(path.join(codexPluginRoot, "custom"), "codex-review");
    await mkdir(path.join(codexPluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(
      path.join(codexPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-reviewer", version: "1.0.0", skills: "custom" }),
    );

    const codexAdapter = PLUGIN_HOST_SPECIFICATIONS.find(({ host }) => host === "codex");
    assert.ok(codexAdapter);
    const hostSpecifications = [CLAUDE_CODE_HOST_ADAPTER, codexAdapter];

    const result = await discoverAmbientSkills({
      input: "review",
      home,
      cwd,
      env: {
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
        CLAUDE_CODE_SYNC_SKILLS: "0",
      },
      managerRecords: [],
      pluginOptions: {
        hostSpecifications,
      },
    });

    assert.ok(result.searchedRoots.length >= 2);
    assert.ok(result.searchedRoots.some(({ pluginIdentity }) =>
      pluginIdentity === "local:plugin:claude-code:official:reviewer"));
    const marketplaceRoot = result.searchedRoots.find(({ pluginIdentity }) =>
      pluginIdentity === "local:plugin:claude-code:team:audit");
    assert.ok(marketplaceRoot);
    assert.equal(marketplaceRoot.active, false);
    assert.deepEqual(
      checkProvenance({ observations: marketplaceRoot.pluginEvidence }).provenance,
      ["repository:https://github.com/example/audit"],
    );
    const malformed = result.pluginDiagnostics.find(
      ({ code }) => code === "MALFORMED_PLUGIN_METADATA",
    );
    assert.equal(malformed?.host, "claude-code");

    const codexResult = await discoverAmbientSkills({
      input: "codex-review",
      home,
      cwd,
      env: {
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
        CLAUDE_CODE_SYNC_SKILLS: "0",
      },
      managerRecords: [],
      pluginOptions: { hostSpecifications },
    });
    assert.equal(codexResult.groups[0].copies[0].plugin.host, "codex");
    assert.equal(
      codexResult.groups[0].copies[0].pluginIdentity,
      "local:plugin:codex:local:codex-reviewer",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
