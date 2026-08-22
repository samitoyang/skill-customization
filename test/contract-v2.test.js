import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  helperContractSupport,
  renderDispatcher,
} from "../src/index.js";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("helper contract 2: the published helper supports contracts 1 and 2", () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  for (const contract of ["1", "2"]) {
    assert.deepEqual(helperContractSupport(contract, packageJson.version), {
      compatible: true,
      requested_contract: contract,
      supported_contracts: ["1", "2"],
      package_version: packageJson.version,
    });
  }
});

test("helper contract 2: new dispatchers negotiate only contract 2 and stop safely", () => {
  for (const [type, maintenanceHandler] of [
    ["semantic-overlay", "skill-overlay"],
    ["fork", "skill-fork"],
  ]) {
    const dispatcher = renderDispatcher(type, {
      name: `review-${type}`,
      description: `Review with a ${type}.`,
    });
    assert.match(dispatcher, /skill-customization supports 2/);
    assert.match(dispatcher, /compatible contract-2 result/);
    assert.match(dispatcher, /Otherwise Call the Skill tool with/);
    assert.ok(
      dispatcher.includes(
        `\`${maintenanceHandler}\` once and execute no customization instructions.`,
      ),
    );
    assert.match(dispatcher, /For \`maintenance-required\`, Call the Skill tool with its returned handler/);
    assert.doesNotMatch(dispatcher, /\bdelegate\b/i);
    assert.doesNotMatch(dispatcher, /skill-customization supports 1|contract-1 result/);
  }
});

test("helper contract 2: public contract inherits contract 1 and adds rendering", async () => {
  const contract = await readFile(
    new URL("../docs/helper-contract-2.md", import.meta.url),
    "utf8",
  );
  assert.match(contract, /includes every behavior in \[helper contract 1\]/i);
  assert.match(contract, /`render-dispatcher`/);
  assert.match(contract, /newly generated dispatchers and overlay or fork creation negotiate only contract 2/i);
});
