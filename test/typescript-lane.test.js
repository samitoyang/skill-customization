import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("publication maps only supported entrypoints to emitted ESM and declarations", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );

  assert.equal(packageJson.main, "./dist/src/index.js");
  assert.equal(packageJson.types, "./dist/src/index.d.ts");
  assert.deepEqual(packageJson.exports, {
    ".": {
      types: "./dist/src/index.d.ts",
      import: "./dist/src/index.js",
      default: "./dist/src/index.js",
    },
    "./schema": "./customization.schema.json",
  });
  assert.deepEqual(Object.keys(packageJson.exports), [".", "./schema"]);
  assert.equal(packageJson.files.includes("dist/package.json"), true);
  assert.equal(packageJson.files.includes("src"), false);
});

test("complete verification delegates runtime checks to the packed-artifact lane", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );

  assert.equal(packageJson.scripts.test, "node scripts/verify-typescript.js");
  assert.doesNotMatch(packageJson.scripts.verify, /npm test|test:ambient|test:artifact/);
  assert.equal(
    (packageJson.scripts.verify.match(/npm run check:package/gu) ?? []).length,
    1,
  );
});

test("TypeScript verification exercises the emitted CLI and library contracts", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-typescript.js")],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verified emitted TypeScript artifact/);
});

test("custom output is a self-contained publication artifact", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "skill-customization-publication-test-"),
  );
  const outputDirectory = path.join(temporaryRoot, "artifact");
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "build-typescript.js"),
        "--publication-out-dir",
        outputDirectory,
      ],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const packageJson = JSON.parse(
      await readFile(path.join(outputDirectory, "package.json"), "utf8"),
    );
    assert.equal(packageJson.exports["."].import, "./dist/src/index.js");
    const [, , , , emittedJavaScriptMap, emittedDeclarationMap] = await Promise.all([
      readFile(path.join(outputDirectory, "bin", "skill-customization.js")),
      readFile(path.join(outputDirectory, "customization.schema.json")),
      readFile(path.join(outputDirectory, "dist", "src", "index.js")),
      readFile(path.join(outputDirectory, "dist", "src", "index.d.ts")),
      readFile(path.join(outputDirectory, "dist", "src", "index.js.map"), "utf8"),
      readFile(path.join(outputDirectory, "dist", "src", "index.d.ts.map"), "utf8"),
    ]);
    for (const sourceMap of [emittedJavaScriptMap, emittedDeclarationMap].map(JSON.parse)) {
      assert.equal(sourceMap.sources.some((source) => source.includes("\\")), false);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
