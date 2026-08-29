import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import {
  repositoryRoot,
  verifyEmittedArtifact,
} from "../../scripts/typescript-lane.js";

const iterations = 5;

await runPerformanceScenario({
  scenario: "artifact-verification",
  lane: "artifact",
  iterations,
  warmupIterations: 0,
  budget: {
    maxMedianMs: 60000,
    maxP95Ms: 90000,
    maxMadMs: 15000,
    exactWork: {
      artifact_verifications: iterations,
    },
  },
  setup: async () => ({
    temporary: await mkdtemp(path.join(os.tmpdir(), "artifact-verification-performance-")),
    artifactVerifications: 0,
  }),
  measure: async (state) => {
    const outputDirectory = path.join(
      state.temporary,
      `artifact-${state.artifactVerifications}`,
    );
    state.artifactVerifications += 1;
    await verifyEmittedArtifact({
      root: repositoryRoot,
      outputDirectory,
      testConcurrency: 1,
    });
    return { artifact_verifications: 1 };
  },
  cleanup: ({ temporary }) => rm(temporary, { recursive: true, force: true }),
});
