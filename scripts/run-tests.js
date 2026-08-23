import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedTestEnvironment } from "./test-environment.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(target)));
    else if (entry.name.endsWith(".test.js")) result.push(target);
  }
  return result;
}

const args = process.argv.slice(2);
let lane = "fixture";
if (args.length > 0) {
  if (
    args.length !== 2
    || args[0] !== "--lane"
    || !["fixture", "ambient", "artifact"].includes(args[1])
  ) {
    throw new TypeError("run-tests accepts only --lane fixture|ambient|artifact");
  }
  lane = args[1];
}
const discovered = (await filesBelow(path.join(root, "test"))).sort();
const isAmbient = (file) => file.endsWith(".ambient.test.js");
const isArtifact = (file) => path.basename(file) === "typescript-lane.test.js";
const tests = discovered.filter((file) =>
  lane === "ambient"
    ? isAmbient(file)
    : lane === "artifact"
      ? isArtifact(file)
      : !isAmbient(file) && !isArtifact(file),
);
if (tests.length === 0) throw new Error(`test lane ${lane} has no test files`);
const isolated = await isolatedTestEnvironment();
try {
  const result = spawnSync(process.execPath, ["--test", ...tests], {
    cwd: isolated.cwd,
    env: isolated.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await isolated.cleanup();
}
