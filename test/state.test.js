import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { acquireStateLock } from "../src/state.js";

const run = promisify(execFile);
const stateModule = pathToFileURL(
  new URL("../src/state.js", import.meta.url).pathname,
).href;

test("a completed atomic write survives immediate process exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "state-durable-write-"));
  const filePath = path.join(root, "nested", "deeper", "state.json");
  const program = `
    import { writeFileAtomic } from ${JSON.stringify(stateModule)};
    await writeFileAtomic(process.env.STATE_PATH, "durable state\\n", { mode: 0o640 });
    process.exit(0);
  `;

  await run(process.execPath, ["--input-type=module", "--eval", program], {
    env: { ...process.env, STATE_PATH: filePath },
  });

  assert.equal(await readFile(filePath, "utf8"), "durable state\n");
  assert.equal((await stat(filePath)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(path.dirname(filePath)), ["state.json"]);
  assert.deepEqual(await readdir(root), ["nested"]);
});

test("atomic updates preserve keys written by concurrent Node processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "state-process-lock-"));
  const statePath = path.join(root, "state.json");
  const program = `
    import { updateJsonAtomic } from ${JSON.stringify(stateModule)};
    await updateJsonAtomic(process.env.STATE_PATH, { version: 1, values: {} }, async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      state.values[process.env.STATE_KEY] = true;
      return state;
    });
  `;
  const invoke = (key) =>
    run(process.execPath, ["--input-type=module", "--eval", program], {
      env: { ...process.env, STATE_PATH: statePath, STATE_KEY: key },
    });

  await Promise.all([invoke("first"), invoke("second")]);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state, {
    version: 1,
    values: { first: true, second: true },
  });
  await assert.rejects(access(`${statePath}.lock`), (error) => error.code === "ENOENT");
});

test("a live owner is never displaced by lock age or a competing waiter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "state-live-lock-"));
  const statePath = path.join(root, "state.json");
  const release = await acquireStateLock(statePath);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(
    acquireStateLock(statePath, { timeoutMs: 30, retryMs: 5 }),
    (error) => error.code === "STATE_LOCK_TIMEOUT",
  );
  await release();
  const releaseSuccessor = await acquireStateLock(statePath, {
    timeoutMs: 30,
    retryMs: 5,
  });
  await releaseSuccessor();
});

test("an abandoned owner is reported without automatic lock theft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "state-abandoned-lock-"));
  const statePath = path.join(root, "state.json");
  const program = `
    import { acquireStateLock } from ${JSON.stringify(stateModule)};
    await acquireStateLock(process.env.STATE_PATH);
  `;
  await run(process.execPath, ["--input-type=module", "--eval", program], {
    env: { ...process.env, STATE_PATH: statePath },
  });

  await assert.rejects(
    acquireStateLock(statePath, { timeoutMs: 30, retryMs: 5 }),
    (error) =>
      error.code === "STATE_LOCK_ABANDONED"
      && error.details.lockPath === `${statePath}.lock`,
  );
  await unlink(`${statePath}.lock`);
});
