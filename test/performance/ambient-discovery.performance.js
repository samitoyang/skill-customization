import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import { PLUGIN_HOST_SPECIFICATIONS } from "../../src/plugin-discovery.js";
import {
  ambientDiscoveryShape,
  ambientPluginEnvironment,
  assertBoundedAmbientPluginDiscovery,
  writeAmbientInstalledPlugin,
  writeAmbientPluginVersion,
} from "../support/ambient-plugin-fixture.js";
import { discoverAmbientSkills } from "../support/discovery-modes.js";
import { captureDiscoveryWork } from "../support/performance-metrics.js";

const iterations = 5;
const ambientHostSpecifications = Object.freeze(
  PLUGIN_HOST_SPECIFICATIONS.filter(({ host }) => host === "claude-code"),
);
// The isolated registry normalizes its 91 declarations to 75 distinct standard
// roots; this fixture declares exactly one Claude plugin skill root as well.
const expectedAmbientStandardRootCount = 75;
const expectedAmbientPluginRootCount = 1;
const expectedAmbientRootCount =
  expectedAmbientStandardRootCount + expectedAmbientPluginRootCount;

await runPerformanceScenario({
  scenario: "ambient-discovery",
  lane: "ambient",
  iterations,
  warmupIterations: 1,
  budget: {
    maxMedianMs: 5000,
    maxP95Ms: 15000,
    maxMadMs: 1000,
    exactWork: {
      discovery_calls: iterations,
      plugin_discovery_calls: iterations,
      manager_collections: 0,
      git_probes: iterations,
      plugin_directory_reads: 3 * iterations,
    },
  },
  setup: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ambient-discovery-performance-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "workspace");
    const claudeHome = path.join(home, ".claude");
    const pluginRoot = path.join(
      claudeHome,
      "plugins",
      "cache",
      "fixture-marketplace",
      "reviewer",
      "1",
    );
    await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })]);
    await writeAmbientPluginVersion(pluginRoot, "1");
    await writeAmbientInstalledPlugin(claudeHome, pluginRoot, "1");
    const env = ambientPluginEnvironment(root, home, claudeHome);
    return {
      root,
      home,
      cwd,
      env,
      expectedShape: undefined,
    };
  },
  measure: async (state) => {
    const { result, metrics } = await captureDiscoveryWork(() =>
      discoverAmbientSkills({
        input: "review",
        home: state.home,
        cwd: state.cwd,
        env: state.env,
        managerRecords: [],
        pluginOptions: { hostSpecifications: ambientHostSpecifications },
      })
    );
    const standardRootCount = result.searchedRoots.filter(
      ({ origin }) => origin !== "plugin",
    ).length;
    const pluginRootCount = result.searchedRoots.filter(
      ({ origin }) => origin === "plugin",
    ).length;
    if (
      standardRootCount !== expectedAmbientStandardRootCount
      || pluginRootCount !== expectedAmbientPluginRootCount
    ) {
      throw new Error("ambient discovery root inventory changed");
    }
    if (metrics.root_scans !== expectedAmbientRootCount) {
      throw new Error("ambient discovery scanned roots more than expected");
    }
    assertBoundedAmbientPluginDiscovery(result, state.root, "1");
    const discoveryShape = ambientDiscoveryShape(result);
    if (state.expectedShape === undefined) {
      state.expectedShape = JSON.stringify(discoveryShape);
    }
    if (JSON.stringify(discoveryShape) !== state.expectedShape) {
      throw new Error("ambient discovery result changed between samples");
    }
    return metrics;
  },
  reportWork: () => ({ ambient_roots: expectedAmbientRootCount }),
  cleanup: ({ root }) => rm(root, { recursive: true, force: true }),
});
