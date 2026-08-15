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

test("helper contract 2: v0.1.1 supports contracts 1 and 2", () => {
  assert.equal(packageJson.version, "0.1.1");
  for (const contract of ["1", "2"]) {
    assert.deepEqual(helperContractSupport(contract, packageJson.version), {
      compatible: true,
      requested_contract: contract,
      supported_contracts: ["1", "2"],
      package_version: "0.1.1",
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
    assert.match(dispatcher, /Otherwise delegate once to/);
    assert.ok(
      dispatcher.includes(
        `\`${maintenanceHandler}\` and execute no customization instructions.`,
      ),
    );
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
