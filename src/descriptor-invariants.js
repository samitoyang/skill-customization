/**
 * @typedef {object} DescriptorObjectInvariant
 * @property {readonly string[]} allowed
 * @property {readonly string[]} required
 * @property {readonly string[]} [additionalRequired]
 */

/**
 * @typedef {object} DescriptorPatternInvariant
 * @property {string} source
 * @property {number} [maxLength]
 */

/**
 * @typedef {object} DescriptorActivationRelationship
 * @property {"coexist" | "replace"} mode
 * @property {"different-from-source" | "same-as-source"} nameRule
 * @property {"forbidden" | "customization-first"} precedence
 */

/**
 * @typedef {object} DescriptorForkRelationship
 * @property {"fork"} descriptorType
 * @property {"fork"} descriptorField
 * @property {readonly string[]} provenanceFields
 * @property {"customization"} sourceKind
 * @property {"semantic-overlay"} sourceType
 * @property {"materialization"} materializationField
 * @property {{sourceFingerprintField: string, snapshotFingerprintField: string, materializationSourceField: string, materializationSnapshotField: string, sourceFingerprintPath: string, snapshotFingerprintPath: string}} materialization
 */

/**
 * @typedef {object} DescriptorInvariantCatalog
 * @property {1} version
 * @property {{topLevel: DescriptorObjectInvariant, source: {common: DescriptorObjectInvariant, variants: {repository: DescriptorObjectInvariant, local: DescriptorObjectInvariant, customization: DescriptorObjectInvariant}}, review: DescriptorObjectInvariant, ownedPayload: DescriptorObjectInvariant, activation: DescriptorObjectInvariant, fork: DescriptorObjectInvariant, materialization: DescriptorObjectInvariant}} fields
 * @property {{schemaVersion: 1, customizationTypes: readonly string[], sourceKinds: readonly string[], activationModes: readonly string[], activationPrecedence: string, dependenciesUnique: boolean}} values
 * @property {{skillName: DescriptorPatternInvariant, stableId: DescriptorPatternInvariant, fingerprint: DescriptorPatternInvariant, localIdentity: DescriptorPatternInvariant, repositoryUrl: DescriptorPatternInvariant, relativePath: DescriptorPatternInvariant, provenancePath: DescriptorPatternInvariant, runtimePathExclusion: DescriptorPatternInvariant, nonBlank: DescriptorPatternInvariant, nonMachinePath: readonly string[]}} patterns
 * @property {{activation: {coexist: DescriptorActivationRelationship, replace: DescriptorActivationRelationship}, fork: DescriptorForkRelationship}} relationships
 * @property {{schemaGaps: Readonly<Record<string, string>>}} runtimeOnly
 */

/**
 * Freeze a descriptor-shaped value recursively while tolerating repeated
 * references in the value graph.
 *
 * @template T
 * @param {T} value
 * @param {Set<object>} [seen]
 * @returns {T}
 */
export function freezeDescriptorValue(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDescriptorValue(child, seen);
  return Object.freeze(value);
}

const sourceCommon = {
  allowed: ["skill_name", "kind", "license", "effective_fingerprint"],
  required: ["skill_name", "kind", "license", "effective_fingerprint"],
};

function sourceVariant(allowed, required) {
  return {
    allowed: [...sourceCommon.allowed, ...allowed],
    required: [...sourceCommon.required, ...required],
    additionalRequired: [...required],
  };
}

const fields = {
  topLevel: {
    allowed: [
      "$schema",
      "schema_version",
      "id",
      "type",
      "name",
      "license",
      "entrypoint",
      "customization",
      "dependencies",
      "owned_payload",
      "source",
      "activation",
      "fork",
    ],
    required: [
      "schema_version",
      "id",
      "type",
      "name",
      "license",
      "entrypoint",
      "customization",
      "dependencies",
      "owned_payload",
      "source",
      "activation",
    ],
  },
  source: {
    common: sourceCommon,
    variants: {
      repository: sourceVariant(
        ["repository", "upstream_path", "review"],
        ["repository", "upstream_path", "review"],
      ),
      local: sourceVariant(["identity"], ["identity"]),
      customization: sourceVariant(["id", "type"], ["id", "type"]),
    },
  },
  review: {
    allowed: ["revision"],
    required: ["revision"],
  },
  ownedPayload: {
    allowed: ["reviewed_fingerprint"],
    required: ["reviewed_fingerprint"],
  },
  activation: {
    allowed: ["mode", "precedence"],
    required: ["mode"],
  },
  fork: {
    allowed: [
      "snapshot",
      "diff",
      "snapshot_fingerprint",
      "diff_fingerprint",
      "materialization",
    ],
    required: [
      "snapshot",
      "diff",
      "snapshot_fingerprint",
      "diff_fingerprint",
    ],
  },
  materialization: {
    allowed: [
      "source_effective_fingerprint",
      "snapshot_fingerprint",
      "reviewed_at",
      "evidence",
    ],
    required: [
      "source_effective_fingerprint",
      "snapshot_fingerprint",
      "reviewed_at",
      "evidence",
    ],
  },
};

const values = {
  schemaVersion: 1,
  customizationTypes: ["semantic-overlay", "fork"],
  sourceKinds: ["repository", "local", "customization"],
  activationModes: ["coexist", "replace"],
  activationPrecedence: "customization-first",
  dependenciesUnique: true,
};

const patterns = {
  skillName: {
    source: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    maxLength: 63,
  },
  stableId: {
    source: String.raw`^(?![Ff][Ii][Ll][Ee]:)(?![A-Za-z]:[\\/])[a-z][a-z0-9+.-]*:[^\s]+$`,
  },
  fingerprint: {
    source: "^sha256:[0-9a-f]{64}$",
  },
  localIdentity: {
    source: "^local:sha256:[0-9a-f]{64}$",
  },
  repositoryUrl: {
    source: String.raw`^https://(?![^/\s]*@)[^/\s]+/[^?#\s]+$`,
  },
  relativePath: {
    source: String.raw`^(?![A-Za-z]:[\\/])(?![\s\S]*[\r\n\u2028\u2029])(?![\s\S]*:)(?![\s\S]*(?:^|/)\.{1,2}(?:/|$))(?![\s\S]*[. ](?:/|$))(?![\s\S]*\\)(?![\s\S]*\u0000)[^/]+(?:/[^/]+)*$`,
  },
  provenancePath: {
    source: String.raw`^provenance/[^/]+(?:/[^/]+)*$`,
  },
  runtimePathExclusion: {
    source: String.raw`(?:^(?:[Cc][Uu][Ss][Tt][Oo][Mm][Ii][Zz][Aa][Tt][Ii][Oo][Nn]\.[Jj][Ss][Oo][Nn]|[Pp][Rr][Oo][Vv][Ee][Nn][Aa][Nn][Cc][Ee])(?:/|$)|(?:^|/)\.(?:[Gg][Ii][Tt]|[Hh][Gg]|[Ss][Vv][Nn])(?:/|$))`,
  },
  nonBlank: {
    source: String.raw`\S`,
  },
  nonMachinePath: [
    "^/",
    String.raw`^\\`,
    String.raw`^[A-Za-z]:[\\/]`,
    "^[Ff][Ii][Ll][Ee]:",
    String.raw`^~[^\\/]*(?:[\\/]|$)`,
  ],
};

const relationships = {
  activation: {
    coexist: {
      mode: "coexist",
      nameRule: "different-from-source",
      precedence: "forbidden",
    },
    replace: {
      mode: "replace",
      nameRule: "same-as-source",
      precedence: "customization-first",
    },
  },
  fork: {
    descriptorType: "fork",
    descriptorField: "fork",
    provenanceFields: ["snapshot", "diff"],
    sourceKind: "customization",
    sourceType: "semantic-overlay",
    materializationField: "materialization",
    materialization: {
      sourceFingerprintField: "effective_fingerprint",
      snapshotFingerprintField: "snapshot_fingerprint",
      materializationSourceField: "source_effective_fingerprint",
      materializationSnapshotField: "snapshot_fingerprint",
      sourceFingerprintPath: "/fork/materialization/source_effective_fingerprint",
      snapshotFingerprintPath: "/fork/materialization/snapshot_fingerprint",
    },
  },
};

const runtimeOnly = {
  schemaGaps: {
    coexistName: "coexist activation requires a customization name distinct from its source",
    replaceName: "replace activation requires a customization name equal to its source",
    activationPrecedence: "coexist activation forbids precedence",
    repositoryCanonicalization: "repository URLs must already be normalized by runtime policy",
    materializationSource: "materialization source fingerprint equals the selected source fingerprint",
    materializationSnapshot: "materialization snapshot fingerprint equals the fork snapshot fingerprint",
  },
};

/** @type {DescriptorInvariantCatalog} */
export const DESCRIPTOR_INVARIANTS = /** @type {DescriptorInvariantCatalog} */ (freezeDescriptorValue({
  version: 1,
  fields,
  values,
  patterns,
  relationships,
  runtimeOnly,
}));

/**
 * Runtime-only relationships that the portable JSON Schema intentionally does
 * not approximate. The parity corpus names and exercises every entry.
 */
export const DESCRIPTOR_SCHEMA_GAPS = DESCRIPTOR_INVARIANTS.runtimeOnly.schemaGaps;
