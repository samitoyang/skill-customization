import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindCustomization } from "../src/bindings.js";
import { fingerprintPath, payloadFingerprint } from "../src/fingerprint.js";
import { preflightCustomization } from "../src/preflight.js";

test("replacement overlays exclude themselves from active inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preflight-replacement-overlay-"));
  const sourceRoot = path.join(root, "review-source");
  const overlayRoot = path.join(root, "review");
  const statePath = path.join(root, "state", "bindings.json");
  const roots = [{ path: root, scope: "workspace", origin: "fixture" }];

  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, "SKILL.md"),
    "---\nname: review\n---\nSource workflow.\n",
  );
  await mkdir(overlayRoot, { recursive: true });
  await writeFile(path.join(overlayRoot, "SKILL.md"), "dispatcher\n");
  await writeFile(path.join(overlayRoot, "CUSTOMIZATION.md"), "replacement delta\n");
  const descriptor = {
    schema_version: 1,
    id: "urn:test:replacement-review-overlay",
    type: "semantic-overlay",
    name: "review",
    license: "MIT",
    entrypoint: "SKILL.md",
    customization: "CUSTOMIZATION.md",
    dependencies: [],
    owned_payload: { reviewed_fingerprint: await payloadFingerprint(overlayRoot) },
    source: {
      skill_name: "review",
      kind: "repository",
      repository: "https://github.com/example/skills",
      upstream_path: "skills/review/SKILL.md",
      license: "MIT",
      effective_fingerprint: await fingerprintPath(sourceRoot),
      review: { revision: "replacement-review" },
    },
    activation: {
      mode: "replace",
      precedence: "customization-first",
    },
  };
  const descriptorPath = path.join(overlayRoot, "customization.json");
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const activeSource = { name: "review", path: sourceRoot };

  await bindCustomization({
    descriptor,
    sourcePath: sourceRoot,
    context: "workspace:test",
    statePath,
    roots,
    interactive: true,
    confirm: async () => true,
    confirmReplace: async () => true,
    activeSkills: [activeSource],
  });

  const result = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath,
    roots,
    activeSkills: [
      activeSource,
      { name: "review", path: overlayRoot },
    ],
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.steps.map(({ role, customizationId }) => ({ role, customizationId })),
    [
      { role: "workflow", customizationId: null },
      { role: "delta", customizationId: descriptor.id },
    ],
  );

  const ambiguous = await preflightCustomization({
    descriptorPath,
    context: "workspace:test",
    statePath,
    roots,
    activeSkills: [
      activeSource,
      { name: "review", path: overlayRoot },
      { name: "review", path: path.join(root, "other-review") },
    ],
  });

  assert.equal(ambiguous.status, "maintenance-required");
  assert.equal(ambiguous.maintenanceHandler.reason, "binding-maintenance");
  assert.match(ambiguous.maintenanceHandler.detail, /ambiguous/i);
});
