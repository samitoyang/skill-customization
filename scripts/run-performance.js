import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scenarioRoot = path.join(root, "test", "performance");
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
  const scenario = path.resolve(root, args[0]);
  const relative = path.relative(scenarioRoot, scenario);
  const valid = relative
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && scenario.endsWith(".performance.js");
  if (!valid || !(await access(scenario).then(() => true, () => false))) {
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
