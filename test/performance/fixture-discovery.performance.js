import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import { discoverFixtureSkills } from "../support/discovery-modes.js";
import { createPerformanceFixtureRoot } from "../support/performance-fixture.js";
import { captureDiscoveryWork } from "../support/performance-metrics.js";

const iterations = 5;

await runPerformanceScenario({
  scenario: "fixture-discovery",
  lane: "fixture",
  iterations,
  warmupIterations: 1,
  budget: {
    maxMedianMs: 500,
    maxP95Ms: 1500,
    maxMadMs: 100,
    exactWork: {
      discovery_calls: iterations,
      root_scans: iterations,
      plugin_discovery_calls: 0,
      manager_collections: 0,
      git_probes: iterations,
      plugin_directory_reads: 0,
    },
  },
  setup: async () => {
    const temporary = await createPerformanceFixtureRoot(
      "fixture-discovery-performance-",
    );
    const skillsRoot = path.join(temporary, "skills");
    const skillRoot = path.join(skillsRoot, "review");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: fixture\n---\nUse it.\n",
    );
    return {
      temporary,
      skillsRoot,
    };
  },
  measure: async (state) => {
    const { result, metrics } = await captureDiscoveryWork(() =>
      discoverFixtureSkills({
        input: "review",
        roots: [{ path: state.skillsRoot, owner: "fixture", scope: "custom" }],
        managerRecords: [],
      })
    );
    if (result.groups.length !== 1 || result.groups[0].name !== "review") {
      throw new Error("fixture discovery changed");
    }
    if (result.searchedRoots.length !== 1 || result.searchedRoots[0].path !== state.skillsRoot) {
      throw new Error("fixture discovery escaped its declared roots");
    }
    return metrics;
  },
  cleanup: ({ temporary }) => rm(temporary, { recursive: true, force: true }),
});
