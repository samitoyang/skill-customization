import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { isolatedTestEnvironment } from "../scripts/test-environment.js";

test("test lanes receive an isolated empty host inventory", async () => {
  const isolated = await isolatedTestEnvironment({
    baseEnv: { PATH: "/fixture/bin", HOME: "/developer/home" },
  });
  try {
    assert.notEqual(isolated.env.HOME, "/developer/home");
    assert.equal(isolated.env.PATH, "/fixture/bin");
    assert.ok(isolated.cwd.startsWith(isolated.directory));
    assert.equal(
      await access(isolated.cwd).then(() => true, () => false),
      true,
    );
    for (const name of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]) {
      assert.equal(
        await access(isolated.env[name]).then(() => true, () => false),
        true,
      );
      assert.ok(isolated.env[name].startsWith(isolated.directory));
    }
    assert.equal(
      isolated.env.ASM_COMMAND,
      path.join(isolated.directory, "unavailable", "asm"),
    );
  } finally {
    await isolated.cleanup();
  }
  assert.equal(
    await access(isolated.directory).then(() => true, () => false),
    false,
  );
});
