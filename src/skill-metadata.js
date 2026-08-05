import { readFile } from "node:fs/promises";

export function parseSkillMetadata(markdown) {
  const block = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  if (!block) return {};
  const metadata = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([a-zA-Z_][\w-]*):\s*["']?([^"']*?)["']?\s*$/);
    if (match) metadata[match[1]] = match[2];
  }
  return metadata;
}

export async function readSkillMetadata(entrypoint) {
  return parseSkillMetadata(await readFile(entrypoint, "utf8"));
}

export async function readSkillName(entrypoint) {
  return (await readSkillMetadata(entrypoint)).name;
}
