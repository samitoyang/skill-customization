import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts", "run-performance.js");

test("performance runner accepts exactly one repository scenario", () => {
  for (const args of [
    [],
    ["test/contract-v1.test.js"],
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

test("performance runner rejects a scenario symlink that escapes its directory", async () => {
  const link = path.join(
    root,
    "test",
    "performance",
    `escape-${process.pid}.performance.js`,
  );
  await symlink(path.join(root, "test", "contract-v1.test.js"), link);
  try {
    const result = spawnSync(process.execPath, [runner, link], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /one test\/performance\/.*\.performance\.js scenario/);
  } finally {
    await unlink(link);
  }
});
