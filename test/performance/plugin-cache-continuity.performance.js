import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bindCustomization, resolveBinding } from "../../src/bindings.js";
import { createDiscoverySnapshot } from "../../src/discovery.js";
import { fingerprintPath } from "../../src/fingerprint.js";
import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import { discoverFixtureSkills } from "../support/discovery-modes.js";
import {
  accumulatePerformanceMetrics,
  captureDiscoveryWork,
} from "../support/performance-metrics.js";

const iterations = 5;

function pluginRoot(directory, version) {
  const identity = "local:plugin:fixture-host:fixture-marketplace:reviewer";
  const plugin = {
    host: "fixture-host",
    marketplace: "fixture-marketplace",
    name: "reviewer",
    version,
  };
  return {
    path: path.dirname(directory),
    owner: "plugin:fixture-host",
    scope: "global",
    origin: "plugin",
    plugin,
    pluginIdentity: identity,
    pluginRoot: path.dirname(path.dirname(directory)),
    pluginEvidence: [{
      kind: "plugin",
      ...plugin,
      repository: "https://github.com/example/reviewer",
      identity,
      cache: { kind: "versioned", scope: "global" },
    }],
  };
}

await runPerformanceScenario({
  scenario: "plugin-cache-continuity",
  lane: "fixture",
  iterations,
  warmupIterations: 1,
  budget: {
    maxMedianMs: 1000,
    maxP95Ms: 3000,
    maxMadMs: 500,
    exactWork: {
      discovery_calls: 5 * iterations,
      root_scans: 14 * iterations,
      git_probes: 9 * iterations,
      manager_collections: 0,
      plugin_discovery_calls: 0,
    },
  },
  setup: async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "plugin-cache-continuity-performance-"));
    const source = path.join(temporary, "plugin", "1", "skills", "review");
    const replacement = path.join(temporary, "plugin", "2", "skills", "review");
    const statePath = path.join(temporary, "state", "bindings.json");
    const workflow = "---\nname: review\n---\nStable source.\n";
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), workflow);
    const descriptor = {
      schema_version: 1,
      id: "urn:test:plugin-cache-continuity",
      type: "semantic-overlay",
      name: "review-local-copy",
      license: "MIT",
      entrypoint: "SKILL.md",
      customization: "CUSTOMIZATION.md",
      dependencies: [],
      owned_payload: {
        reviewed_fingerprint:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      source: {
        skill_name: "review",
        kind: "repository",
        license: "MIT",
        repository: "https://github.com/example/reviewer",
        upstream_path: "skills/review/SKILL.md",
        effective_fingerprint: await fingerprintPath(source),
        review: { revision: "fixture" },
      },
      activation: { mode: "coexist" },
    };
    const initialRoot = pluginRoot(source, "1");
    const replacementRoot = pluginRoot(replacement, "2");
    await bindCustomization({
      descriptor,
      sourcePath: source,
      context: "global",
      statePath,
      roots: [initialRoot],
      interactive: true,
      confirm: async () => true,
    });
    const discovery = await discoverFixtureSkills({ roots: [initialRoot], managerRecords: [] });
    await rename(path.join(temporary, "plugin", "1"), path.join(temporary, "removed"));
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(replacement, "SKILL.md"), workflow);
    return {
      temporary,
      descriptor,
      statePath,
      roots: [initialRoot, replacementRoot],
      discovery,
      staleSource: source,
      metrics: {},
    };
  },
  measure: async (state, { phase }) => {
    const { metrics } = await captureDiscoveryWork(async () => {
      await resolveBinding({
        descriptor: state.descriptor,
        context: "global",
        statePath: state.statePath,
        discovery: state.discovery,
        discoverySnapshot: createDiscoverySnapshot({
          discovery: state.discovery,
          roots: state.roots,
          managerRecords: [],
        }),
        roots: state.roots,
        managerRecords: [],
      });
    });
    if (
      metrics.discovery_calls !== 5
      || metrics.root_scans !== 14
      || metrics.git_probes !== 9
    ) {
      throw new Error("plugin cache continuity discovery work changed");
    }
    const store = JSON.parse(await readFile(state.statePath, "utf8"));
    const binding = store.bindings[`${encodeURIComponent(state.descriptor.id)}::global`];
    binding.source.path = state.staleSource;
    binding.source.target = state.staleSource;
    await writeFile(state.statePath, `${JSON.stringify(store, null, 2)}\n`);
    if (phase === "measure") accumulatePerformanceMetrics(state.metrics, metrics);
  },
  work: (state) => ({
    discovery_calls: state.metrics.discovery_calls ?? 0,
    root_scans: state.metrics.root_scans ?? 0,
    git_probes: state.metrics.git_probes ?? 0,
    manager_collections: state.metrics.manager_collections ?? 0,
    plugin_discovery_calls: state.metrics.plugin_discovery_calls ?? 0,
  }),
  cleanup: ({ temporary }) => rm(temporary, { recursive: true, force: true }),
});
