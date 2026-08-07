import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(target)));
    else result.push(target);
  }
  return result;
}

if (Number(process.versions.node.split(".")[0]) < 18) {
  throw new Error("Node.js 18 or newer is required");
}

const javascript = (
  await Promise.all(
    ["src", "bin", "scripts", "test", "skills"].map(
      async (directory) => filesBelow(path.join(root, directory)),
    ),
  )
)
  .flat()
  .filter((file) => file.endsWith(".js"));

for (const file of javascript) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr || `syntax check failed: ${file}`);
}

JSON.parse(await readFile(path.join(root, "customization.schema.json"), "utf8"));
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

const contractCheck = spawnSync(
  process.execPath,
  [path.join(root, "bin", "skill-customization.js"), "supports", "1"],
  { encoding: "utf8" },
);
if (contractCheck.status !== 0) {
  throw new Error(contractCheck.stderr || "helper contract 1 is unsupported");
}
const contractResult = JSON.parse(contractCheck.stdout);
if (
  contractResult.compatible !== true
  || contractResult.requested_contract !== "1"
  || !contractResult.supported_contracts?.includes("1")
  || contractResult.package_version !== packageJson.version
) {
  throw new Error("helper contract 1 check returned an invalid result");
}

for (const skillName of ["skill-overlay", "skill-fork"]) {
  const skillRoot = path.join(root, "skills", skillName);
  const markdown = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  if (!markdown.startsWith(`---\nname: ${skillName}\n`)) {
    throw new Error(`${skillName}/SKILL.md frontmatter name does not match its folder`);
  }
  if (markdown.includes("../")) {
    throw new Error(`${skillName}/SKILL.md must not reference files outside its skill root`);
  }
  if (
    !markdown.includes("skill-customization supports 1")
    || !markdown.includes("skill-customization@latest supports 1")
  ) {
    throw new Error(`${skillName}/SKILL.md must negotiate helper contract 1`);
  }
  await readFile(path.join(skillRoot, "references", "intake.md"), "utf8");
  const evals = JSON.parse(
    await readFile(path.join(skillRoot, "evals", "evals.json"), "utf8"),
  );
  if (evals.skill_name !== skillName || evals.evals.length < 3) {
    throw new Error(`${skillName} evals are incomplete`);
  }
}

process.stdout.write(
  `verified ${javascript.length} JavaScript files, schema, helper contract 1, package, and skills\n`,
);
