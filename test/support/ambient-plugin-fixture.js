import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const AMBIENT_PLUGIN_REPOSITORY = "https://github.com/example/reviewer";
export const AMBIENT_PLUGIN_IDENTITY =
  "local:plugin:claude-code:fixture-marketplace:reviewer";
export const AMBIENT_PLUGIN_WORKFLOW = "---\nname: review\n---\nstable\n";

export function ambientPluginEnvironment(root, home, claudeHome) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: claudeHome,
    CURSOR_HOME: path.join(home, ".cursor"),
    GEMINI_CLI_HOME: home,
    COPILOT_SKILLS_DIRS: "",
    CLAUDE_CODE_SYNC_SKILLS: "0",
  };
}

export async function writeAmbientPluginVersion(pluginRoot, version) {
  const source = path.join(pluginRoot, "skills", "review");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), AMBIENT_PLUGIN_WORKFLOW);
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "reviewer",
      version,
      repository: AMBIENT_PLUGIN_REPOSITORY,
    }),
  );
  return source;
}

export async function writeAmbientInstalledPlugin(claudeHome, pluginRoot, version) {
  const pluginsRoot = path.join(claudeHome, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  await writeFile(
    path.join(pluginsRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "reviewer@fixture-marketplace": [{
          scope: "user",
          installPath: pluginRoot,
          version,
        }],
      },
    }),
  );
}

export function ambientDiscoveryShape(result) {
  return {
    searchedRoots: result.searchedRoots.map(({ path: rootPath, owner, scope, origin }) => ({
      path: rootPath,
      owner,
      scope,
      origin,
    })),
    groups: result.groups.map(({ name, fingerprint, copies }) => ({
      name,
      fingerprint,
      copies: copies.map(({ path: copyPath, owner, scope, origin, plugin, pluginIdentity }) => ({
        path: copyPath,
        owner,
        scope,
        origin,
        plugin,
        pluginIdentity,
      })),
    })),
  };
}

export function assertBoundedAmbientPluginDiscovery(result, root, version) {
  const withinFixture = (target) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  };
  assert.ok(result.searchedRoots.length > 0);
  assert.ok(result.searchedRoots.every(({ path: rootPath }) => withinFixture(rootPath)));
  assert.deepEqual(result.groups.map(({ name }) => name), ["review"]);
  const copies = result.groups.flatMap(({ copies: groupCopies }) => groupCopies);
  assert.ok(copies.length > 0);
  assert.ok(copies.every((copy) => withinFixture(copy.path)));
  assert.ok(copies.every(({ origin }) => origin === "plugin"));
  assert.ok(copies.every(({ pluginIdentity }) => pluginIdentity === AMBIENT_PLUGIN_IDENTITY));
  assert.ok(copies.every(({ plugin }) => plugin.version === version));
}
