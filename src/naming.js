import { DESCRIPTOR_INVARIANTS } from "./descriptor-invariants.js";
import { getActivationNameConflict } from "./descriptor-activation.js";

const KEBAB = new RegExp(DESCRIPTOR_INVARIANTS.patterns.skillName.source);
const MAX_NAME_LENGTH = DESCRIPTOR_INVARIANTS.patterns.skillName.maxLength;
const ACTIVATION_RELATIONSHIPS = DESCRIPTOR_INVARIANTS.relationships.activation;
const AVOIDED_SUFFIXES = ["-overlay", "-fork", "-custom"];

export function validateSkillName(name) {
  return typeof name === "string" && KEBAB.test(name) && name.length <= MAX_NAME_LENGTH
    ? []
    : ["name must be lowercase kebab-case and shorter than 64 characters"];
}

export function normalizeSkillName(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
}

export function validateCustomizationName({
  name,
  sourceName,
  mode = "coexist",
  folderName,
  inventory = [],
}) {
  const errors = validateSkillName(name);
  const avoided = AVOIDED_SUFFIXES.find((suffix) => name?.endsWith(suffix));
  if (avoided) errors.push(`name should describe the outcome instead of ending in ${avoided}`);
  if (folderName !== undefined && name !== folderName) {
    errors.push("name must equal the customization folder name");
  }
  const inventoryNames = new Set(
    inventory.map((item) => (typeof item === "string" ? item : item.name)),
  );
  if (inventoryNames.has(name)) errors.push(`name ${name} collides with the inventory`);
  if (getActivationNameConflict(mode, name, sourceName) === ACTIVATION_RELATIONSHIPS.coexist.mode) {
    errors.push("coexist mode requires a name different from the source");
  }
  if (getActivationNameConflict(mode, name, sourceName) === ACTIVATION_RELATIONSHIPS.replace.mode) {
    errors.push("replace mode requires the same name as the source");
  }
  return errors;
}

export function suggestCustomizationNames({ sourceName, outcome, inventory = [] }) {
  const source = normalizeSkillName(sourceName);
  const outcomeWords = normalizeSkillName(outcome)
    .split("-")
    .filter((word) => !["overlay", "fork", "custom"].includes(word));
  if (!source || outcomeWords.length === 0) {
    throw new TypeError("sourceName and a concrete outcome are required before naming");
  }
  const normalizedOutcome = outcomeWords.join("-");
  const reversedOutcome = [...outcomeWords].reverse().join("-");
  const candidates = [
    `${source}-${normalizedOutcome}`,
    `${source}-${reversedOutcome}`,
    `${normalizedOutcome}-${source}`,
    `${source}-${normalizedOutcome}-workflow`,
    `${source}-${normalizedOutcome}-support`,
    `${normalizedOutcome}-workflow-${source}`,
  ].map(normalizeSkillName);
  const inventoryNames = new Set(
    inventory.map((item) => (typeof item === "string" ? item : item.name)),
  );
  const available = [...new Set(candidates)]
    .filter((name) => name !== source && !inventoryNames.has(name))
    .filter(
      (name) =>
        validateCustomizationName({ name, sourceName: source, mode: "coexist" }).length === 0,
    )
    .slice(0, 3);
  if (available.length < 2) {
    throw new TypeError(
      "fewer than two collision-free outcome names are available; refine the outcome",
    );
  }
  return available;
}
