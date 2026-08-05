import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_ROOT_REGISTRY_CHECKPOINT = Object.freeze({
  repository: "https://github.com/vercel-labs/skills",
  revision: "305ff8be68e59368789d765e2cf0edfab851c453",
  file: "src/agents.ts",
});

const VERCEL_AGENT_ROOTS = [
  ["amp", ".agents/skills", ["xdg-config", "agents/skills"]],
  ["antigravity", ".agent/skills", ["home", ".gemini/antigravity/skills"]],
  ["augment", ".augment/skills", ["home", ".augment/skills"]],
  ["claude-code", ".claude/skills", ["claude-home", "skills"]],
  ["openclaw", "skills", ["openclaw-home", "skills"]],
  ["cline", ".cline/skills", ["home", ".cline/skills"]],
  ["codebuddy", ".codebuddy/skills", ["home", ".codebuddy/skills"]],
  ["codex", ".agents/skills", ["codex-home", "skills"]],
  ["command-code", ".commandcode/skills", ["home", ".commandcode/skills"]],
  ["continue", ".continue/skills", ["home", ".continue/skills"]],
  ["cortex", ".cortex/skills", ["home", ".snowflake/cortex/skills"]],
  ["crush", ".crush/skills", ["home", ".config/crush/skills"]],
  ["cursor", ".agents/skills", ["home", ".cursor/skills"]],
  ["droid", ".factory/skills", ["home", ".factory/skills"]],
  ["gemini-cli", ".agents/skills", ["home", ".gemini/skills"]],
  ["github-copilot", ".agents/skills", ["home", ".copilot/skills"]],
  ["goose", ".goose/skills", ["xdg-config", "goose/skills"]],
  ["junie", ".junie/skills", ["home", ".junie/skills"]],
  ["iflow-cli", ".iflow/skills", ["home", ".iflow/skills"]],
  ["kilo", ".kilocode/skills", ["home", ".kilocode/skills"]],
  ["kimi-cli", ".agents/skills", ["home", ".config/agents/skills"]],
  ["kiro-cli", ".kiro/skills", ["home", ".kiro/skills"]],
  ["kode", ".kode/skills", ["home", ".kode/skills"]],
  ["mcpjam", ".mcpjam/skills", ["home", ".mcpjam/skills"]],
  ["mistral-vibe", ".vibe/skills", ["home", ".vibe/skills"]],
  ["mux", ".mux/skills", ["home", ".mux/skills"]],
  ["opencode", ".agents/skills", ["xdg-config", "opencode/skills"]],
  ["openhands", ".openhands/skills", ["home", ".openhands/skills"]],
  ["pi", ".pi/skills", ["home", ".pi/agent/skills"]],
  ["qoder", ".qoder/skills", ["home", ".qoder/skills"]],
  ["qwen-code", ".qwen/skills", ["home", ".qwen/skills"]],
  ["replit", ".agents/skills", ["xdg-config", "agents/skills"]],
  ["roo", ".roo/skills", ["home", ".roo/skills"]],
  ["trae", ".trae/skills", ["home", ".trae/skills"]],
  ["trae-cn", ".trae/skills", ["home", ".trae-cn/skills"]],
  ["windsurf", ".windsurf/skills", ["home", ".codeium/windsurf/skills"]],
  ["zencoder", ".zencoder/skills", ["home", ".zencoder/skills"]],
  ["neovate", ".neovate/skills", ["home", ".neovate/skills"]],
  ["pochi", ".pochi/skills", ["home", ".pochi/skills"]],
  ["adal", ".adal/skills", ["home", ".adal/skills"]],
  ["universal", ".agents/skills", ["xdg-config", "agents/skills"]],
].map(([owner, project, global]) =>
  Object.freeze({ owner, project, global: Object.freeze(global) }),
);

const LEGACY_ROOTS = [
  ["codex", ".codex/skills", ["codex-home", "skills"]],
  ["agents", ".agents/skills", ["home", ".agents/skills"]],
  ["claude", ".claude/skills", ["claude-home", "skills"]],
  ["copilot", ".github/skills", ["home", ".copilot/skills"]],
  ["cursor", ".cursor/skills", null],
].map(([owner, project, global]) =>
  Object.freeze({
    owner,
    project,
    global: global ? Object.freeze(global) : null,
    legacy: true,
  }),
);

export const SKILL_ROOT_REGISTRY = Object.freeze([
  ...LEGACY_ROOTS,
  ...VERCEL_AGENT_ROOTS,
]);

function openClawHome(home, pathExists) {
  for (const directory of [".openclaw", ".clawdbot", ".moltbot"]) {
    if (pathExists(path.join(home, directory))) return path.join(home, directory);
  }
  return path.join(home, ".openclaw");
}

function resolveBase(base, { home, env, pathExists }) {
  if (base === "home") return home;
  if (base === "xdg-config") {
    return env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  }
  if (base === "codex-home") {
    return env.CODEX_HOME?.trim() || path.join(home, ".codex");
  }
  if (base === "claude-home") {
    return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  }
  if (base === "openclaw-home") return openClawHome(home, pathExists);
  throw new TypeError(`unsupported skill-root base ${base}`);
}

export function registrySkillRoots({
  home = os.homedir(),
  workspaceDirectories = [process.cwd()],
  env = process.env,
  pathExists = existsSync,
} = {}) {
  const roots = [];
  const resolvedHome = path.resolve(home);
  for (const entry of SKILL_ROOT_REGISTRY) {
    for (const workspace of workspaceDirectories) {
      const directory = typeof workspace === "string" ? workspace : workspace.path;
      roots.push({
        path: path.resolve(directory, entry.project),
        owner: entry.owner,
        scope: "workspace",
        origin: typeof workspace === "string"
          ? "project"
          : workspace.origin ?? "project",
        registry: entry.legacy ? "legacy" : "vercel-skills",
      });
    }
    if (entry.global) {
      const [base, relative] = entry.global;
      roots.push({
        path: path.resolve(
          resolveBase(base, { home: resolvedHome, env, pathExists }),
          relative,
        ),
        owner: entry.owner,
        scope: "global",
        origin: "personal",
        registry: entry.legacy ? "legacy" : "vercel-skills",
      });
    }
  }
  return roots;
}
