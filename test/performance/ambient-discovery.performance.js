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
import {
  accumulatePerformanceMetrics,
  captureDiscoveryWork,
} from "../support/performance-metrics.js";

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
      git_probes: 0,
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
      metrics: {},
      expectedShape: undefined,
    };
  },
  measure: async (state, { phase }) => {
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
    if (phase === "measure") {
      accumulatePerformanceMetrics(state.metrics, metrics);
    }
    assertBoundedAmbientPluginDiscovery(result, state.root, "1");
    const discoveryShape = ambientDiscoveryShape(result);
    if (state.expectedShape === undefined) {
      state.expectedShape = JSON.stringify(discoveryShape);
    }
    if (JSON.stringify(discoveryShape) !== state.expectedShape) {
      throw new Error("ambient discovery result changed between samples");
    }
  },
  work: (state) => ({
    discovery_calls: state.metrics.discovery_calls ?? 0,
    plugin_discovery_calls: state.metrics.plugin_discovery_calls ?? 0,
    manager_collections: state.metrics.manager_collections ?? 0,
    git_probes: state.metrics.git_probes ?? 0,
    plugin_directory_reads: state.metrics.plugin_directory_reads ?? 0,
    root_scans: state.metrics.root_scans ?? 0,
    ambient_roots: expectedAmbientRootCount,
  }),
  cleanup: ({ root }) => rm(root, { recursive: true, force: true }),
});
