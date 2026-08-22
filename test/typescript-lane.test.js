import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("TypeScript verification exercises the emitted CLI and library contracts", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-typescript.js")],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verified emitted TypeScript artifact/);
});
