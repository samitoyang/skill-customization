import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/skill-customization.js", import.meta.url));

function run(args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeSkill(root, folder, name = folder) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\nUse this skill.\n`,
  );
  return directory;
}

test("CLI discovery loads bounded Claude additionalDirectories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-claude-settings-"));
  const home = path.join(root, "home");
  const additional = path.join(root, "team");
  const skill = path.join(
    additional,
    ".claude",
    "skills",
    "claude-cli-fixture",
  );
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ additionalDirectories: [additional] }),
  );
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: claude-cli-fixture\n---\nfixture\n",
  );

  const result = await run(["discover", "claude-cli-fixture"], {
    env: { ...process.env, HOME: home, PATH: "" },
  });
  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].name, "claude-cli-fixture");
  assert.equal(discovery.groups[0].copies[0].owner, "claude-additional");
  assert.equal(discovery.settingsEvidence.length, 1);
});
test("CLI discovery uses ambient Claude plugins and supports the deterministic opt-out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-claude-plugin-"));
  const home = path.join(root, "home");
  const pluginRoot = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "official",
    "cli-reviewer",
    "1",
  );
  const skill = await writeSkill(path.join(pluginRoot, "skills"), "cli-plugin-review");
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cli-reviewer" }),
  );

  const environment = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    PATH: "",
  };
  const discovered = await run(["discover", "cli-plugin-review"], { env: environment });
  assert.equal(discovered.code, 0, discovered.stderr);
  const result = JSON.parse(discovered.stdout);
  assert.equal(result.groups[0].copies[0].path, skill);
  assert.equal(result.groups[0].copies[0].plugin.name, "cli-reviewer");

  const disabled = await run(
    ["discover", "cli-plugin-review", "--include-plugins", "false"],
    { env: environment },
  );
  assert.equal(disabled.code, 1);
  assert.match(disabled.stderr, /NO_LOCAL_COPY/);
});


test("CLI discovery finds Gemini skills from the configured CLI home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-gemini-extension-"));
  const fallbackHome = path.join(root, "fallback-home");
  const configuredHome = path.join(root, "configured-home");
  const extension = path.join(
    configuredHome,
    ".gemini",
    "extensions",
    "cli-gemini-extension",
  );
  const skill = await writeSkill(path.join(extension, "skills"), "cli-gemini-review");
  await writeFile(
    path.join(extension, "gemini-extension.json"),
    JSON.stringify({
      name: "cli-gemini-extension",
      version: "1.0.0",
      repository: "https://github.com/example/cli-gemini-extension",
    }),
  );

  const result = await run(["discover", "cli-gemini-review"], {
    env: {
      ...process.env,
      HOME: fallbackHome,
      GEMINI_CLI_HOME: configuredHome,
      PATH: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].copies[0].path, skill);
  assert.equal(discovery.groups[0].copies[0].owner, "plugin:gemini-cli");
  assert.deepEqual(discovery.groups[0].provenance, [
    "repository:https://github.com/example/cli-gemini-extension",
  ]);
});



test("CLI discovery finds Cursor local plugin skills with manifest provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-cursor-local-plugin-"));
  const home = path.join(root, "home");
  const plugin = path.join(home, ".cursor", "plugins", "local", "cli-plugin");
  const skill = await writeSkill(plugin, "custom", "cli-cursor-review");
  await mkdir(path.join(plugin, ".cursor-plugin"), { recursive: true });
  await writeFile(
    path.join(plugin, ".cursor-plugin", "plugin.json"),
    JSON.stringify({
      name: "cli-plugin",
      skills: "custom",
      repository: "https://github.com/example/cli-plugin",
    }),
  );

  const result = await run(["discover", "cli-cursor-review"], {
    env: {
      ...process.env,
      HOME: home,
      CURSOR_HOME: path.join(home, ".cursor"),
      PATH: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].copies[0].path, skill);
  assert.equal(discovery.groups[0].copies[0].owner, "plugin:cursor");
  assert.deepEqual(discovery.groups[0].provenance, [
    "repository:https://github.com/example/cli-plugin",
  ]);
});



test("CLI discovery finds Codex personal marketplace skills with plugin provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-codex-marketplace-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const plugin = path.join(home, "plugins", "cli-plugin");
  const skill = await writeSkill(plugin, "custom", "cli-codex-review");
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(plugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "cli-plugin",
      version: "1.0.0",
      repository: "https://github.com/example/cli-plugin",
      skills: "./custom",
    }),
  );
  await mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(home, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "personal",
      plugins: [{
        name: "cli-plugin",
        source: { source: "local", path: "./plugins/cli-plugin" },
      }],
    }),
  );

  const result = await run(["discover", "cli-codex-review"], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].copies[0].path, skill);
  assert.equal(discovery.groups[0].copies[0].plugin.host, "codex");
  assert.equal(discovery.groups[0].copies[0].plugin.marketplace, "personal");
  assert.deepEqual(discovery.groups[0].provenance, [
    "repository:https://github.com/example/cli-plugin",
  ]);
});



test("CLI discovery finds Codex config.toml marketplace skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-codex-config-marketplace-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const marketplaceRoot = path.join(root, "configured-marketplace");
  const plugin = path.join(marketplaceRoot, "plugins", "cli-config-plugin");
  const skill = await writeSkill(plugin, "custom", "cli-config-review");
  await mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(plugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "cli-config-plugin",
      skills: "./custom",
      repository: "https://github.com/example/cli-config-plugin",
    }),
  );
  await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "configured-marketplace",
      plugins: [{
        name: "cli-config-plugin",
        source: { source: "local", path: "./plugins/cli-config-plugin" },
      }],
    }),
  );
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "config.toml"),
    `[marketplaces."configured-marketplace"]\nsource_type = "local"\nsource = "${marketplaceRoot}"\n`,
  );

  const result = await run(["discover", "cli-config-review"], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: "",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const discovery = JSON.parse(result.stdout);
  assert.equal(discovery.groups[0].copies[0].path, skill);
  assert.equal(discovery.groups[0].copies[0].plugin.marketplace, "configured-marketplace");
  assert.deepEqual(discovery.groups[0].provenance, [
    "repository:https://github.com/example/cli-config-plugin",
  ]);
});
