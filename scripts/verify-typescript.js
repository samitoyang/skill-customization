import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repositoryRoot, verifyEmittedArtifact } from "./typescript-lane.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "skill-customization-typescript-"));
const outputDirectory = path.join(temporaryRoot, "artifact");
try {
  await verifyEmittedArtifact({ root: repositoryRoot, outputDirectory });
  process.stdout.write(`verified emitted TypeScript artifact at ${outputDirectory}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
