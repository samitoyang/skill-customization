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

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 14)) {
  throw new Error("Node.js 22.14 or newer is required");
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

for (const contract of ["1", "2"]) {
  const contractCheck = spawnSync(
    process.execPath,
    [path.join(root, "bin", "skill-customization.js"), "supports", contract],
    { encoding: "utf8" },
  );
  if (contractCheck.status !== 0) {
    throw new Error(contractCheck.stderr || `helper contract ${contract} is unsupported`);
  }
  const contractResult = JSON.parse(contractCheck.stdout);
  if (
    contractResult.compatible !== true
    || contractResult.requested_contract !== contract
    || !contractResult.supported_contracts?.includes(contract)
    || contractResult.package_version !== packageJson.version
  ) {
    throw new Error(`helper contract ${contract} check returned an invalid result`);
  }
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
    !markdown.includes("skill-customization supports 2")
    || !markdown.includes("skill-customization@latest supports 2")
  ) {
    throw new Error(`${skillName}/SKILL.md must negotiate helper contract 2`);
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
  `verified ${javascript.length} JavaScript files, schema, helper contracts 1 and 2, package, and skills\n`,
);
