import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNpmPackReport } from "../scripts/npm-pack-report.js";

const packageReport = {
  name: "skill-customization",
  files: [{ path: "package.json", mode: 0o644 }],
  entryCount: 1,
  unpackedSize: 100,
};

test("npm pack reports normalize legacy and npm 12 single-package shapes", () => {
  assert.equal(normalizeNpmPackReport([packageReport]), packageReport);
  assert.equal(
    normalizeNpmPackReport({ "skill-customization": packageReport }),
    packageReport,
  );
});

test("npm pack reports reject empty, multi-package, and malformed shapes", () => {
  for (const report of [
    [],
    {},
    [packageReport, packageReport],
    { first: packageReport, second: packageReport },
    null,
    "not a report",
    [null],
    { "skill-customization": { files: "not a file list" } },
  ]) {
    assert.throws(
      () => normalizeNpmPackReport(report),
      /npm pack returned an unexpected report/,
    );
  }
});
