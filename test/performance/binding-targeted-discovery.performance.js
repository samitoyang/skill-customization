import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bindCustomization, resolveBinding } from "../../src/bindings.js";
import { createDiscoverySnapshot } from "../../src/discovery.js";
import { fingerprintFile, fingerprintPath, payloadFingerprint } from "../../src/fingerprint.js";
import { generateLocalIdentity } from "../../src/normalization.js";
import { discoverFixtureSkills } from "../support/discovery-modes.js";
import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import {
  accumulatePerformanceMetrics,
  captureDiscoveryWork,
} from "../support/performance-metrics.js";

const iterations = 5;

await runPerformanceScenario({
  scenario: "binding-targeted-discovery",
  lane: "fixture",
  iterations,
  warmupIterations: 1,
  budget: {
    maxMedianMs: 1000,
    maxP95Ms: 3000,
    maxMadMs: 500,
    exactWork: {
      discovery_calls: iterations,
      root_scans: 2 * iterations,
      git_probes: 2 * iterations,
      manager_collections: 0,
      plugin_discovery_calls: 0,
    },
  },
  setup: async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "binding-targeted-discovery-performance-"));
    const seededRoot = path.join(temporary, "seeded");
    const sourceRoot = path.join(temporary, "source");
    const source = path.join(sourceRoot, "review");
    const customizationRoot = path.join(temporary, "customization");
    const statePath = path.join(temporary, "state", "bindings.json");
    await mkdir(path.join(seededRoot, "seeded"), { recursive: true });
    await writeFile(
      path.join(seededRoot, "seeded", "SKILL.md"),
      "---\nname: seeded\n---\nSeeded inventory.\n",
    );
    await mkdir(source, { recursive: true });
    const sourceEntrypoint = path.join(source, "SKILL.md");
    await writeFile(
      sourceEntrypoint,
      "---\nname: review\n---\nTargeted source.\n",
    );
    await mkdir(customizationRoot, { recursive: true });
    await writeFile(
      path.join(customizationRoot, "SKILL.md"),
      "---\nname: review-local-copy\n---\nCustomization.\n",
    );
    await writeFile(path.join(customizationRoot, "CUSTOMIZATION.md"), "Delta.\n");

    const sourceFingerprint = await fingerprintPath(source);
    const descriptor = {
      schema_version: 1,
      id: "urn:test:binding-targeted-discovery",
      type: "semantic-overlay",
      name: "review-local-copy",
      license: "MIT",
      entrypoint: "SKILL.md",
      customization: "CUSTOMIZATION.md",
      dependencies: [],
      owned_payload: {
        reviewed_fingerprint: await payloadFingerprint(customizationRoot),
      },
      source: {
        skill_name: "review",
        kind: "local",
        license: "MIT",
        identity: generateLocalIdentity({
          skillName: "review",
          fingerprint: await fingerprintFile(sourceEntrypoint),
        }),
        effective_fingerprint: sourceFingerprint,
      },
      activation: { mode: "coexist" },
    };
    const roots = [
      { path: seededRoot, scope: "workspace", origin: "fixture" },
    ];
    const discovery = await discoverFixtureSkills({
      roots: [roots[0]],
      managerRecords: [],
    });
    return {
      temporary,
      descriptor,
      source,
      statePath,
      roots,
      discovery,
      customizationRoot,
      metrics: {},
    };
  },
  measure: async (state, { phase }) => {
    const { metrics } = await captureDiscoveryWork(async () => {
      const discoverySnapshot = createDiscoverySnapshot({
        discovery: state.discovery,
        roots: state.roots,
        managerRecords: [],
      });
      await bindCustomization({
        descriptor: state.descriptor,
        sourcePath: state.source,
        context: "workspace:performance",
        statePath: state.statePath,
        customizationRoot: state.customizationRoot,
        requestedScope: "workspace",
        interactive: true,
        confirm: async () => true,
        discovery: state.discovery,
        discoverySnapshot,
        roots: state.roots,
        managerRecords: [],
      });
      await resolveBinding({
        descriptor: state.descriptor,
        context: "workspace:performance",
        statePath: state.statePath,
        customizationRoot: state.customizationRoot,
        discovery: state.discovery,
        discoverySnapshot,
        roots: state.roots,
        managerRecords: [],
      });
    });
    const expected = phase === "warmup"
      ? { discovery_calls: 2, root_scans: 4 }
      : { discovery_calls: 1, root_scans: 2 };
    if (metrics.discovery_calls !== expected.discovery_calls || metrics.root_scans !== expected.root_scans) {
      throw new Error(
        `[DEBUG-ci-performance-counters] targeted Binding discovery work changed: ${JSON.stringify({ phase, expected, metrics })}`,
      );
    }
    if (phase === "measure") {
      accumulatePerformanceMetrics(state.metrics, metrics);
    }
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
