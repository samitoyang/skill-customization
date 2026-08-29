import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createPerformanceFixtureRoot(prefix) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
  return realpath(temporary);
}
