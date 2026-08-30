function resolveReference(root, reference) {
  if (!reference.startsWith("#/")) {
    throw new TypeError(`only local JSON Schema references are supported: ${reference}`);
  }
  return reference.slice(2).split("/").reduce(
    (value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
    root,
  );
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

/**
 * Minimal, dependency-free JSON Schema adapter for the keywords used by the
 * exported Descriptor schema. Keeping it in test support makes schema parity
 * executable without adding a production runtime dependency.
 */
export function matchesJsonSchema(root, schema, value) {
  if (typeof schema === "boolean") return schema;
  if (schema.$ref !== undefined) {
    return matchesJsonSchema(root, resolveReference(root, schema.$ref), value);
  }
  if (schema.type !== undefined && !matchesType(value, schema.type)) return false;
  if (schema.const !== undefined && !Object.is(value, schema.const)) return false;
  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.pattern !== undefined && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) return false;
  if (schema.minLength !== undefined && (typeof value !== "string" || value.length < schema.minLength)) return false;
  if (schema.maxLength !== undefined && (typeof value !== "string" || value.length > schema.maxLength)) return false;
  if (schema.allOf !== undefined && !schema.allOf.every((item) => matchesJsonSchema(root, item, value))) return false;
  if (schema.oneOf !== undefined && schema.oneOf.filter((item) => matchesJsonSchema(root, item, value)).length !== 1) return false;
  if (schema.not !== undefined && matchesJsonSchema(root, schema.not, value)) return false;
  if (schema.if !== undefined) {
    const branch = matchesJsonSchema(root, schema.if, value) ? schema.then : schema.else;
    if (branch !== undefined && !matchesJsonSchema(root, branch, value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items !== undefined && !value.every((item) => matchesJsonSchema(root, schema.items, item))) return false;
  }
  if (matchesType(value, "object")) {
    if (schema.required !== undefined && !schema.required.every((key) => key in value)) return false;
    if (schema.properties !== undefined && !Object.entries(schema.properties).every(
      ([key, child]) => !(key in value) || matchesJsonSchema(root, child, value[key]),
    )) return false;
    if (schema.additionalProperties === false && !Object.keys(value).every(
      (key) => key in (schema.properties ?? {}),
    )) return false;
  }
  return true;
}
