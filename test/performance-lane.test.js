import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts", "run-performance.js");

test("performance scenarios run alone in a fresh process", () => {
  const result = spawnSync(
    process.execPath,
    [runner, "test/performance/fixture-discovery.performance.js"],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "isolated");
  assert.equal(report.scenario, "fixture-discovery");
  assert.equal(report.iterations, 5);
  assert.equal(typeof report.duration_ms, "number");
});

test("performance runner accepts exactly one repository scenario", () => {
  for (const args of [
    [],
    ["test/discovery.test.js"],
    ["test/performance/one.performance.js", "test/performance/two.performance.js"],
  ]) {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /one test\/performance\/.*\.performance\.js scenario/);
  }
});
