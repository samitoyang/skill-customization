import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function isolatedTestEnvironment({
  baseEnv = process.env,
} = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "skill-customization-test-inventory-"),
  );
  const home = path.join(directory, "home");
  const config = path.join(directory, "config");
  const data = path.join(directory, "data");
  const state = path.join(directory, "state");
  const workspace = path.join(directory, "workspace");
  await Promise.all([home, config, data, state, workspace].map((target) =>
    mkdir(target, { recursive: true }),
  ));
  return {
    directory,
    cwd: workspace,
    env: {
      ...baseEnv,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CURSOR_HOME: path.join(home, ".cursor"),
      GEMINI_CLI_HOME: home,
      COPILOT_SKILLS_DIRS: "",
      ASM_COMMAND: path.join(directory, "unavailable", "asm"),
      XING_SKILLS_MANAGER_COMMAND: path.join(
        directory,
        "unavailable",
        "skills-manager",
      ),
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
