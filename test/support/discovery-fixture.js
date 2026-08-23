import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFixtureSkill(root, name) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n---\nUse it.\n`,
  );
  return directory;
}
