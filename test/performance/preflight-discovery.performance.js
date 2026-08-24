import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bindCustomization } from "../../src/bindings.js";
import { fingerprintPath, fingerprintValues, payloadFingerprint } from "../../src/fingerprint.js";
import { preflightCustomization } from "../../src/preflight.js";
import { runPerformanceScenario } from "../../scripts/performance-gate.js";
import {
  accumulatePerformanceMetrics,
  captureDiscoveryWork,
} from "../support/performance-metrics.js";

const repository = "https://github.com/example/skills";
const iterations = 5;

async function writeRuntimeFiles(root, name, customization) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    `---\nname: ${name}\n---\nRun preflight and follow its checked steps.\n`,
  );
  await writeFile(path.join(root, "CUSTOMIZATION.md"), `${customization}\n`);
}

function overlayDescriptor({ id, name, owned, source }) {
  return {
    schema_version: 1,
    id,
    type: "semantic-overlay",
    name,
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: owned },
    source,
    activation: { mode: "coexist" },
  };
}

async function writeDescriptor(root, descriptor) {
  await writeFile(
    path.join(root, "customization.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
}

await runPerformanceScenario({
  scenario: "preflight-discovery",
  lane: "fixture",
  iterations,
  warmupIterations: 1,
  budget: {
    maxMedianMs: 1000,
    maxP95Ms: 3000,
    maxMadMs: 500,
    exactWork: {
      discovery_calls: iterations,
      root_scans: iterations,
      git_probes: 3 * iterations,
      manager_collections: 0,
      plugin_discovery_calls: 0,
    },
  },
  setup: async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "preflight-discovery-performance-"));
    const base = path.join(root, "review");
    const inner = path.join(root, "review-archive");
    const outer = path.join(root, "review-archive-notify");
    await mkdir(base, { recursive: true });
    await writeFile(
      path.join(base, "SKILL.md"),
      "---\nname: review\n---\nBase workflow.\n",
    );
    const baseFingerprint = await fingerprintPath(base);

    await writeRuntimeFiles(inner, "review-archive", "Apply the archive delta.");
    const innerDescriptor = overlayDescriptor({
      id: "urn:test:performance-review-archive",
      name: "review-archive",
      owned: await payloadFingerprint(inner),
      source: {
        skill_name: "review",
        kind: "repository",
        repository,
        upstream_path: "skills/review/SKILL.md",
        license: "MIT",
        effective_fingerprint: baseFingerprint,
        review: { revision: "base-review" },
      },
    });
    await writeDescriptor(inner, innerDescriptor);
    const innerEffective = fingerprintValues(
      [
        innerDescriptor.id,
        "delta",
        innerDescriptor.customization,
        baseFingerprint,
        innerDescriptor.owned_payload.reviewed_fingerprint,
      ],
      "skill-customization-overlay-effective-v1",
    );

    await writeRuntimeFiles(outer, "review-archive-notify", "Apply the notification delta.");
    const outerDescriptor = overlayDescriptor({
      id: "urn:test:performance-review-archive-notify",
      name: "review-archive-notify",
      owned: await payloadFingerprint(outer),
      source: {
        skill_name: "review-archive",
        kind: "customization",
        id: innerDescriptor.id,
        type: innerDescriptor.type,
        license: innerDescriptor.license,
        effective_fingerprint: innerEffective,
      },
    });
    await writeDescriptor(outer, outerDescriptor);

    const roots = [{ path: root, scope: "workspace", origin: "fixture" }];
    const statePath = path.join(root, "state", "bindings.json");
    await bindCustomization({
      descriptor: innerDescriptor,
      sourcePath: base,
      context: "workspace:test",
      statePath,
      roots,
      managerRecords: [],
      interactive: true,
      confirm: async () => true,
    });
    await bindCustomization({
      descriptor: outerDescriptor,
      sourcePath: inner,
      context: "workspace:test",
      statePath,
      roots,
      managerRecords: [],
      interactive: true,
      confirm: async () => true,
    });
    return {
      root,
      statePath,
      roots,
      descriptorPath: path.join(outer, "customization.json"),
      metrics: {},
    };
  },
  measure: async (state, { phase }) => {
    const { result, metrics } = await captureDiscoveryWork(() =>
      preflightCustomization({
        descriptorPath: state.descriptorPath,
        context: "workspace:test",
        statePath: state.statePath,
        roots: state.roots,
        managerRecords: [],
      })
    );
    if (result.status !== "ready" || result.steps.length !== 3) {
      throw new Error("preflight discovery result changed");
    }
    if (metrics.discovery_calls !== 1 || metrics.root_scans !== 1) {
      throw new Error("preflight discovery work changed");
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
  cleanup: ({ root }) => rm(root, { recursive: true, force: true }),
});
