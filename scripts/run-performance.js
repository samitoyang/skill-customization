import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scenarioRoot = path.join(root, "test", "performance");
const canonicalScenarioRoot = await realpath(scenarioRoot);
const args = process.argv.slice(2);

function fail() {
  process.stderr.write(
    "run-performance requires one test/performance/*.performance.js scenario\n",
  );
  process.exitCode = 1;
}

if (args.length !== 1) {
  fail();
} else {
  const requestedScenario = path.resolve(root, args[0]);
  const scenario = await realpath(requestedScenario).catch(() => undefined);
  const relative = scenario
    ? path.relative(canonicalScenarioRoot, scenario)
    : undefined;
  const valid = relative
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && requestedScenario.endsWith(".performance.js")
    && scenario.endsWith(".performance.js")
    && await stat(scenario).then((entry) => entry.isFile(), () => false);
  if (!valid) {
    fail();
  } else {
    const result = spawnSync(process.execPath, [scenario], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SKILL_CUSTOMIZATION_PERFORMANCE_MODE: "isolated",
      },
    });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  }
}
