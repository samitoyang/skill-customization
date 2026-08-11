import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { payloadFingerprint } from "../src/fingerprint.js";

const execFileAsync = promisify(execFile);

test("owned payload rejects unsupported filesystem nodes", {
  skip: process.platform === "win32" ? "FIFO fixtures require POSIX" : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "payload-unsupported-node-"));
  await writeFile(path.join(root, "SKILL.md"), "dispatcher\n");
  await execFileAsync("mkfifo", [path.join(root, "runtime-input")]);

  await assert.rejects(
    payloadFingerprint(root),
    (error) => error.code === "OWNED_PAYLOAD_UNSUPPORTED_NODE"
      && /runtime-input/.test(error.message),
  );
});
