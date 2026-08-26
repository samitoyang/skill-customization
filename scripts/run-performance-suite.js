import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, "scripts", "run-performance.js");
const scenarios = Object.freeze([
  "test/performance/fixture-discovery.performance.js",
  "test/performance/binding-targeted-discovery.performance.js",
  "test/performance/plugin-cache-continuity.performance.js",
  "test/performance/preflight-discovery.performance.js",
  "test/performance/ambient-discovery.performance.js",
  "test/performance/artifact-verification.performance.js",
]);

const reports = [];
let failed = false;
for (const scenario of scenarios) {
  const result = spawnSync(process.execPath, [runner, scenario], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    failed = true;
    process.stderr.write(`${scenario}: ${result.error.message}\n`);
    continue;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    failed = true;
    continue;
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    failed = true;
    process.stderr.write(`${scenario}: expected one structured performance report\n`);
    continue;
  }
  try {
    reports.push(JSON.parse(lines[0]));
  } catch (error) {
    failed = true;
    process.stderr.write(`${scenario}: invalid performance report: ${error.message}\n`);
  }
}

if (!failed) {
  process.stdout.write(`${JSON.stringify({
    suite: "performance-regression-gates",
    scenarios: reports.map(({ scenario, lane, duration_ms, work }) => ({
      scenario,
      lane,
      duration_ms,
      work,
    })),
  })}\n`);
}
process.exitCode = failed ? 1 : 0;
