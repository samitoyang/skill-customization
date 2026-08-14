import { validateSkillName } from "./naming.js";

const MAINTENANCE_HANDLERS = Object.freeze({
  "semantic-overlay": "skill-overlay",
  fork: "skill-fork",
});

const FRONTMATTER_ORDER = Object.freeze([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "argument-hint",
  "disable-model-invocation",
  "user-invocable",
]);
const APPROVED_FRONTMATTER_FIELDS = new Set(FRONTMATTER_ORDER);
const UNSAFE_FRONTMATTER_CHARACTERS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u;

function serializeValue(value) {
  return typeof value === "string" ? JSON.stringify(value) : value;
}

function serializeFrontmatter(metadata) {
  return FRONTMATTER_ORDER.flatMap((field) => {
    if (!Object.hasOwn(metadata, field)) return [];
    if (field !== "metadata") {
      return `${field}: ${serializeValue(metadata[field])}`;
    }
    const keys = Object.keys(metadata.metadata).sort();
    if (keys.length === 0) return "metadata: {}";
    return [
      "metadata:",
      ...keys.map(
        (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(metadata.metadata[key])}`,
      ),
    ];
  }).join("\n");
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireMetadataRecord(metadata) {
  if (!isPlainRecord(metadata)) {
    throw new TypeError("metadata must be a plain object");
  }
}

function reservedFieldVariant(field) {
  if (typeof field !== "string") return undefined;
  const normalized = field.toLowerCase().replaceAll("_", "-");
  return APPROVED_FRONTMATTER_FIELDS.has(normalized) ? normalized : undefined;
}

function rejectUnapprovedFields(metadata) {
  for (const field of Reflect.ownKeys(metadata)) {
    if (typeof field !== "string" || !APPROVED_FRONTMATTER_FIELDS.has(field)) {
      const duplicate = reservedFieldVariant(field);
      if (duplicate && Object.hasOwn(metadata, duplicate)) {
        throw new TypeError(`metadata field ${String(field)} duplicates reserved field ${duplicate}`);
      }
      throw new TypeError(`metadata field ${String(field)} is not approved`);
    }
  }
}

function rejectUnsafeString(field, value) {
  if (UNSAFE_FRONTMATTER_CHARACTERS.test(value)) {
    throw new TypeError(`${field} must not contain line breaks or control characters`);
  }
}

function validateOptionalMetadata(metadata) {
  for (const [field, maximum] of [
    ["license", 500],
    ["compatibility", 500],
    ["allowed-tools", 1024],
    ["argument-hint", 1024],
  ]) {
    if (
      Object.hasOwn(metadata, field) &&
      (
        typeof metadata[field] !== "string" ||
        metadata[field].trim().length === 0 ||
        metadata[field].length > maximum
      )
    ) {
      throw new TypeError(`${field} must be a non-empty string of at most ${maximum} characters`);
    }
    if (Object.hasOwn(metadata, field)) rejectUnsafeString(field, metadata[field]);
  }
  for (const field of ["disable-model-invocation", "user-invocable"]) {
    if (Object.hasOwn(metadata, field) && typeof metadata[field] !== "boolean") {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
  if (!Object.hasOwn(metadata, "metadata")) return;
  if (!isPlainRecord(metadata.metadata)) {
    throw new TypeError("metadata must be a plain object whose keys and values are strings");
  }
  for (const key of Reflect.ownKeys(metadata.metadata)) {
    if (typeof key !== "string") {
      throw new TypeError("metadata must contain only string keys and values");
    }
    const value = metadata.metadata[key];
    const duplicate = reservedFieldVariant(key);
    if (duplicate) {
      throw new TypeError(`nested metadata key ${key} duplicates reserved field ${duplicate}`);
    }
    if (key.trim().length === 0 || key.length > 128 || typeof value !== "string") {
      throw new TypeError(
        "metadata must be a plain object with non-empty keys of at most 128 characters and string values",
      );
    }
    rejectUnsafeString("metadata keys", key);
    rejectUnsafeString("metadata values", value);
  }
}

function requireCoreMetadata(metadata) {
  for (const field of ["name", "description"]) {
    if (!Object.hasOwn(metadata, field)) {
      throw new TypeError(`${field} is required`);
    }
  }
}

function validateCoreMetadata(metadata) {
  const [nameError] = validateSkillName(metadata.name);
  if (nameError) throw new TypeError(nameError);
  if (
    typeof metadata.description !== "string" ||
    metadata.description.trim().length === 0 ||
    metadata.description.length > 1024
  ) {
    throw new TypeError("description must be a non-empty string of at most 1024 characters");
  }
  rejectUnsafeString("description", metadata.description);
}

export function renderDispatcher(customizationType, metadata) {
  if (
    typeof customizationType !== "string" ||
    !Object.hasOwn(MAINTENANCE_HANDLERS, customizationType)
  ) {
    const received = typeof customizationType === "string"
      ? customizationType
      : typeof customizationType;
    throw new TypeError(`unsupported customization type: ${received}`);
  }
  const maintenanceHandler = MAINTENANCE_HANDLERS[customizationType];
  requireMetadataRecord(metadata);
  rejectUnapprovedFields(metadata);
  requireCoreMetadata(metadata);
  validateCoreMetadata(metadata);
  validateOptionalMetadata(metadata);
  return `---
${serializeFrontmatter(metadata)}
---

# Managed dispatcher

1. Select the helper. Run \`skill-customization supports 1\`. Accept only an exit-0 JSON result with \`compatible: true\`, \`requested_contract: "1"\`, \`supported_contracts\` containing \`"1"\`, and a non-empty \`package_version\`. Otherwise, delegate once to \`${maintenanceHandler}\` and end this invocation before loading any customization instructions.
   **Gate:** one compatible contract-1 helper is selected, or \`${maintenanceHandler}\` owns the invocation.

2. Preflight. With the selected helper, run \`skill-customization preflight customization.json --context <current-context>\`. Continue only for \`ready\` or \`ready-with-advisory\`. For \`maintenance-required\`, delegate once to exactly the returned maintenance handler and end this invocation before loading any customization instructions.
   **Gate:** preflight returns one complete checked plan, or one maintenance handler owns the invocation.

3. Compose before action. Load every file referenced by the ordered \`steps\` before performing any workflow action. The \`workflow\` step supplies the base or complete workflow; apply every \`delta\` step from inner to outer so each later delta refines the earlier instructions.
   **Gate:** the entire checked plan is loaded and composed into one effective workflow.

4. Execute. Report the advisory for \`ready-with-advisory\`, then execute only the resulting effective workflow.
   **Completion:** the effective workflow is complete.
`;
}
