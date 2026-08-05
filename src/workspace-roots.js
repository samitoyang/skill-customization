import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function boundedWorkspaceDirectories({
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const visited = [];
  let current = resolvedCwd;
  while (current !== path.dirname(current) && current !== resolvedHome) {
    visited.push(current);
    if (existsSync(path.join(current, ".git"))) return visited;
    current = path.dirname(current);
  }
  return [resolvedCwd];
}
