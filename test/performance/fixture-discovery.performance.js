import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { discoverFixtureSkills } from "../support/discovery-modes.js";

if (process.env.SKILL_CUSTOMIZATION_PERFORMANCE_MODE !== "isolated") {
  throw new Error("performance scenarios must use scripts/run-performance.js");
}

const iterations = 5;
const temporary = await mkdtemp(path.join(os.tmpdir(), "fixture-discovery-performance-"));
const skillsRoot = path.join(temporary, "skills");
const skillRoot = path.join(skillsRoot, "review");

try {
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: review\ndescription: fixture\n---\nUse it.\n",
  );
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const result = await discoverFixtureSkills({
      input: "review",
      roots: [{ path: skillsRoot, owner: "fixture", scope: "custom" }],
      managerRecords: [],
    });
    if (result.groups.length !== 1) throw new Error("fixture discovery changed");
  }
  const duration = performance.now() - started;
  process.stdout.write(`${JSON.stringify({
    mode: "isolated",
    scenario: "fixture-discovery",
    iterations,
    duration_ms: duration,
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
