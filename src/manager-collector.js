import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  normalizeManagerRecords,
  parseAsmJson,
  parseJtianlingSources,
  parseVercelV3Lock,
  parseXingJson,
  readXingSqlite,
} from "./managers.js";
import { boundedWorkspaceDirectories } from "./workspace-roots.js";

const execFile = promisify(execFileCallback);

async function executableOnPath(command, env) {
  if (command.includes(path.sep)) {
    return access(command, constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (
      await access(path.join(directory, command), constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function defaultRun(command, args, { env }) {
  return execFile(command, args, {
    encoding: "utf8",
    env,
    timeout: 2_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function commandOutput(value) {
  return value && typeof value === "object" && "stdout" in value
    ? value.stdout
    : value;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

function recordsFromControlPath(records, controlPath) {
  return records.map((record) => ({ ...record, controlPath }));
}

export function defaultManagerSources({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const workspaceDirectories = boundedWorkspaceDirectories({ cwd, home });
  return {
    vercelLocks: unique([
      ...workspaceDirectories.map((directory) =>
        path.join(directory, ".agents", ".skill-lock.json"),
      ),
      path.join(home, ".agents", ".skill-lock.json"),
    ]),
    jtianlingSources: unique([
      path.join(home, ".skills-manager", "library", "sources.json"),
      path.join(home, ".skills-manager", "sources.json"),
    ]),
    xingDatabases: unique([
      path.join(dataHome, "skills-manager", "skills.db"),
      path.join(home, ".skills-manager", "skills.db"),
      path.join(home, "Library", "Application Support", "skills-manager", "skills.db"),
    ]),
  };
}

export function managerSkillRoots(records) {
  return records
    .filter(({ path: managerPath }) => managerPath)
    .map((record) => ({
      kind: "manager",
      path:
        path.basename(record.path).toLowerCase() === "skill.md"
          ? path.dirname(record.path)
          : record.path,
      owner: `manager:${record.manager}`,
      scope: record.scope ?? "global",
      origin: "manager",
    }));
}

async function readIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function collectManagerRecords({
  home = os.homedir(),
  cwd = process.cwd(),
  env = process.env,
  sources = defaultManagerSources({ home, cwd, env }),
  run = defaultRun,
  sqliteRun,
  commands = {
    asm: { command: env.ASM_COMMAND ?? "asm", args: ["list", "--json"] },
    xing: {
      command: env.XING_SKILLS_MANAGER_COMMAND ?? "skills-manager",
      args: ["list", "--json"],
    },
  },
  commandAvailable = executableOnPath,
} = {}) {
  const records = [];
  const diagnostics = [];
  const workspaceDirectories = boundedWorkspaceDirectories({ cwd, home });
  for (const lockPath of sources.vercelLocks ?? []) {
    try {
      const data = await readIfPresent(lockPath);
      if (data === undefined) continue;
      const scope = workspaceDirectories.some((directory) =>
        path.resolve(lockPath).startsWith(`${path.resolve(directory)}${path.sep}`),
      )
        ? "workspace"
        : "global";
      records.push(...recordsFromControlPath(
        parseVercelV3Lock(data, { lockPath, scope }), lockPath,
      ));
      diagnostics.push({ manager: "vercel", source: lockPath, status: "read" });
    } catch (error) {
      diagnostics.push({ manager: "vercel", source: lockPath, status: "error", error: error.message });
    }
  }

  for (const [manager, parser] of [
    ["asm", parseAsmJson],
    ["xing", parseXingJson],
  ]) {
    const spec = commands[manager];
    if (!spec) continue;
    try {
      if (!(await commandAvailable(spec.command, env))) {
        diagnostics.push({ manager, source: "cli", status: "unavailable" });
        continue;
      }
      const output = await run(spec.command, spec.args, { env, manager });
      const parsed = parser(commandOutput(output));
      records.push(...parsed);
      diagnostics.push({ manager, source: "cli", status: "read", records: parsed.length });
    } catch (error) {
      diagnostics.push({ manager, source: "cli", status: "error", error: error.message });
    }
  }

  if (!records.some(({ manager }) => manager === "xing")) {
    for (const database of sources.xingDatabases ?? []) {
      if (!(await access(database).then(() => true, () => false))) {
        continue;
      }
      try {
        const parsed = await readXingSqlite(database, { run: sqliteRun });
        records.push(...recordsFromControlPath(parsed, database));
        diagnostics.push({ manager: "xing", source: database, status: "read", records: parsed.length });
        break;
      } catch (error) {
        diagnostics.push({ manager: "xing", source: database, status: "error", error: error.message });
      }
    }
  }

  for (const sourcePath of sources.jtianlingSources ?? []) {
    try {
      const data = await readIfPresent(sourcePath);
      if (data === undefined) continue;
      const libraryRoot = path.dirname(sourcePath);
      const parsed = parseJtianlingSources(data, { root: libraryRoot });
      records.push(...recordsFromControlPath(parsed, sourcePath));
      diagnostics.push({ manager: "jtianling", source: sourcePath, status: "read", records: parsed.length });
    } catch (error) {
      diagnostics.push({ manager: "jtianling", source: sourcePath, status: "error", error: error.message });
    }
  }
  return { records: normalizeManagerRecords(records), diagnostics };
}
