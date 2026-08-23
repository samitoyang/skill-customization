import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { DescriptorError } from "./errors.js";
import { normalizeRepositoryUrl } from "./normalization.js";
import { isOwnedPayloadExcludedPath } from "./owned-payload.js";
import { isMachineAbsolutePath, resolveOwnedPath } from "./paths.js";

/**
 * @typedef {object} DescriptorValidationError
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {object} DescriptorInventoryRecord
 * @property {string} id
 * @property {string} name
 */

/**
 * @typedef {object} DescriptorRepositorySource
 * @property {string} skill_name
 * @property {"repository"} kind
 * @property {string} repository
 * @property {string} upstream_path
 * @property {string} license
 * @property {string} effective_fingerprint
 * @property {{revision: string}} review
 */

/**
 * @typedef {object} DescriptorLocalSource
 * @property {string} skill_name
 * @property {"local"} kind
 * @property {string} identity
 * @property {string} license
 * @property {string} effective_fingerprint
 */

/**
 * @typedef {object} DescriptorCustomizationSource
 * @property {string} skill_name
 * @property {"customization"} kind
 * @property {string} id
 * @property {"semantic-overlay" | "fork"} type
 * @property {string} license
 * @property {string} effective_fingerprint
 */

/**
 * @typedef {DescriptorRepositorySource | DescriptorLocalSource | DescriptorCustomizationSource} DescriptorSource
 */

/**
 * @typedef {object} DescriptorActivation
 * @property {"coexist" | "replace"} mode
 * @property {"customization-first"} [precedence]
 */

/**
 * @typedef {object} DescriptorForkMaterialization
 * @property {string} source_effective_fingerprint
 * @property {string} snapshot_fingerprint
 * @property {string} reviewed_at
 * @property {string} evidence
 */

/**
 * @typedef {object} DescriptorFork
 * @property {string} snapshot
 * @property {string} diff
 * @property {string} snapshot_fingerprint
 * @property {string} diff_fingerprint
 * @property {DescriptorForkMaterialization} [materialization]
 */

/**
 * @typedef {object} CustomizationDescriptor
 * @property {string} [$schema]
 * @property {1} schema_version
 * @property {string} id
 * @property {"semantic-overlay" | "fork"} type
 * @property {string} name
 * @property {string} license
 * @property {string} entrypoint
 * @property {string} customization
 * @property {readonly string[]} dependencies
 * @property {{reviewed_fingerprint: string}} owned_payload
 * @property {DescriptorSource} source
 * @property {DescriptorActivation} activation
 * @property {DescriptorFork} [fork]
 */

/**
 * @typedef {object} DescriptorInput
 * @property {string} descriptorPath
 * @property {readonly DescriptorInventoryRecord[]} [inventory]
 */

/**
 * @typedef {object} DescriptorLocation
 * @property {string} descriptorPath
 * @property {string} root
 * @property {string} canonicalRoot
 */

/**
 * @typedef {object} DescriptorArtifact
 * @property {"descriptor" | "entrypoint" | "customization" | "snapshot" | "diff"} kind
 * @property {"file" | "directory"} type
 * @property {string} relative
 * @property {string} path
 * @property {string} canonicalPath
 */

/**
 * @typedef {object} CheckedDescriptor
 * @property {Readonly<CustomizationDescriptor>} descriptor
 * @property {Readonly<DescriptorLocation>} location
 * @property {readonly DescriptorArtifact[]} artifacts
 */

/**
 * @typedef {object} DescriptorDiagnostic
 * @property {string} code
 * @property {"input" | "read" | "parse" | "validation" | "folder" | "inventory" | "artifact"} stage
 * @property {string} message
 * @property {string} [causeCode]
 * @property {string} [causeMessage]
 * @property {"descriptor" | "entrypoint" | "customization" | "snapshot" | "diff"} [artifactKind]
 * @property {readonly DescriptorValidationError[] | Record<string, unknown> | string} [details]
 */

/**
 * @typedef {object} DescriptorIngestionSuccess
 * @property {true} ok
 * @property {CheckedDescriptor} checked
 * @property {readonly []} diagnostics
 */

/**
 * @typedef {object} DescriptorIngestionFailure
 * @property {false} ok
 * @property {null} checked
 * @property {readonly DescriptorDiagnostic[]} diagnostics
 */

/**
 * @typedef {DescriptorIngestionSuccess | DescriptorIngestionFailure} DescriptorIngestion
 */

const TOP_LEVEL = new Set([
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
]);
const SOURCE_COMMON = new Set([
  "skill_name",
  "kind",
  "license",
  "effective_fingerprint",
]);
const REPOSITORY_SOURCE = new Set([
  ...SOURCE_COMMON,
  "repository",
  "upstream_path",
  "review",
]);
const LOCAL_SOURCE = new Set([...SOURCE_COMMON, "identity"]);
const CUSTOMIZATION_SOURCE = new Set([
  ...SOURCE_COMMON,
  "id",
  "type",
]);
const ACTIVATION = new Set(["mode", "precedence"]);
const REVIEW = new Set(["revision"]);
const OWNED_PAYLOAD = new Set(["reviewed_fingerprint"]);
const FORK = new Set([
  "snapshot",
  "diff",
  "snapshot_fingerprint",
  "diff_fingerprint",
  "materialization",
]);
const MATERIALIZATION = new Set([
  "source_effective_fingerprint",
  "snapshot_fingerprint",
  "reviewed_at",
  "evidence",
]);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STABLE_ID = /^[a-z][a-z0-9+.-]*:\S+$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const LOCAL_IDENTITY = /^local:sha256:[0-9a-f]{64}$/;

function issue(errors, pointer, message) {
  errors.push({ path: pointer, message });
}

function checkObject(errors, value, pointer, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issue(errors, pointer, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, `${pointer}/${key}`, "is not allowed");
  }
  return true;
}

function checkRequired(errors, value, pointer, keys) {
  for (const key of keys) {
    if (!(key in value)) issue(errors, `${pointer}/${key}`, "is required");
  }
}

function checkName(errors, value, pointer) {
  if (typeof value !== "string" || !KEBAB.test(value) || value.length > 63) {
    issue(errors, pointer, "must be lowercase kebab-case and shorter than 64 characters");
  }
}

function checkStableId(errors, value, pointer) {
  if (
    typeof value !== "string"
    || !STABLE_ID.test(value)
    || isMachineAbsolutePath(value)
  ) {
    issue(errors, pointer, "must be a stable absolute URI such as a URN");
  }
}

function checkFingerprint(errors, value, pointer) {
  if (!FINGERPRINT.test(value ?? "")) {
    issue(errors, pointer, "must be sha256 followed by 64 lowercase hex characters");
  }
}

function checkPortableNonEmptyString(errors, value, pointer, label) {
  if (typeof value !== "string" || !value.trim()) {
    issue(errors, pointer, `must be a non-empty ${label}`);
  } else if (isMachineAbsolutePath(value)) {
    issue(errors, pointer, "must not be a machine-local absolute path");
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (
    value.includes("\\")
    || value.includes("\0")
    || value.includes(":")
    || /[\r\n\u2028\u2029]/.test(value)
  ) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.split("/");
  return !parts.some(
    (part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part),
  );
}

function validateSource(source, errors) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    issue(errors, "/source", "must be an object");
    return;
  }
  const allowed = source.kind === "repository"
    ? REPOSITORY_SOURCE
    : source.kind === "local"
      ? LOCAL_SOURCE
      : source.kind === "customization"
        ? CUSTOMIZATION_SOURCE
        : SOURCE_COMMON;
  checkObject(errors, source, "/source", allowed);
  checkRequired(errors, source, "/source", [
    "skill_name",
    "kind",
    "license",
    "effective_fingerprint",
  ]);
  checkName(errors, source.skill_name, "/source/skill_name");
  checkPortableNonEmptyString(errors, source.license, "/source/license", "license identifier");
  checkFingerprint(errors, source.effective_fingerprint, "/source/effective_fingerprint");

  if (source.kind === "repository") {
    checkRequired(errors, source, "/source", [
      "repository",
      "upstream_path",
      "review",
    ]);
    let canonicalRepository = false;
    try {
      const url = new URL(source.repository);
      canonicalRepository = url.protocol === "https:"
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && normalizeRepositoryUrl(source.repository) === source.repository;
    } catch {
      canonicalRepository = false;
    }
    if (!canonicalRepository) {
      issue(errors, "/source/repository", "must be a credential-free HTTPS repository URL");
    }
    if (!isPortableRelativePath(source.upstream_path)) {
      issue(errors, "/source/upstream_path", "must be a portable relative path");
    }
    if (checkObject(errors, source.review, "/source/review", REVIEW)) {
      checkRequired(errors, source.review, "/source/review", ["revision"]);
      checkPortableNonEmptyString(
        errors,
        source.review.revision,
        "/source/review/revision",
        "review revision",
      );
    }
  } else if (source.kind === "local") {
    checkRequired(errors, source, "/source", ["identity"]);
    if (!LOCAL_IDENTITY.test(source.identity ?? "")) {
      issue(errors, "/source/identity", "must be a generated local:sha256 identity, never a filesystem path");
    }
  } else if (source.kind === "customization") {
    checkRequired(errors, source, "/source", ["id", "type"]);
    checkStableId(errors, source.id, "/source/id");
    if (!["semantic-overlay", "fork"].includes(source.type)) {
      issue(errors, "/source/type", "must be semantic-overlay or fork");
    }
  } else {
    issue(errors, "/source/kind", "must be repository, local, or customization");
  }
}

function validateActivation(descriptor, errors) {
  if (!checkObject(errors, descriptor.activation, "/activation", ACTIVATION)) return;
  checkRequired(errors, descriptor.activation, "/activation", ["mode"]);
  const mode = descriptor.activation.mode;
  if (!["coexist", "replace"].includes(mode)) {
    issue(errors, "/activation/mode", "must be coexist or replace");
  }
  if (mode === "coexist") {
    if ("precedence" in descriptor.activation) {
      issue(errors, "/activation/precedence", "is only valid for replace mode");
    }
    if (descriptor.name === descriptor.source?.skill_name) {
      issue(errors, "/name", "coexist mode requires a name different from the source skill");
    }
  }
  if (mode === "replace") {
    if (descriptor.name !== descriptor.source?.skill_name) {
      issue(errors, "/name", "replace mode requires the same name as the source skill");
    }
    if (descriptor.activation.precedence !== "customization-first") {
      issue(errors, "/activation/precedence", "replace mode requires deterministic customization-first precedence");
    }
  }
}

function validateFork(descriptor, errors) {
  if (descriptor.type !== "fork") {
    if (descriptor.fork !== undefined) issue(errors, "/fork", "is only valid for fork customizations");
    return;
  }
  if (!checkObject(errors, descriptor.fork, "/fork", FORK)) return;
  checkRequired(errors, descriptor.fork, "/fork", [
    "snapshot",
    "diff",
    "snapshot_fingerprint",
    "diff_fingerprint",
  ]);
  for (const key of ["snapshot", "diff"]) {
    if (!isPortableRelativePath(descriptor.fork[key])) {
      issue(errors, `/fork/${key}`, "must be a portable relative path");
    } else if (!descriptor.fork[key].startsWith("provenance/")) {
      issue(
        errors,
        `/fork/${key}`,
        "must be stored beneath the reserved provenance/ directory",
      );
    }
  }
  checkFingerprint(errors, descriptor.fork.snapshot_fingerprint, "/fork/snapshot_fingerprint");
  checkFingerprint(errors, descriptor.fork.diff_fingerprint, "/fork/diff_fingerprint");
  const needsMaterialization = descriptor.source?.kind === "customization"
    && descriptor.source.type === "semantic-overlay";
  if (needsMaterialization && descriptor.fork.materialization === undefined) {
    issue(errors, "/fork/materialization", "is required when forking an overlay source");
  }
  if (!needsMaterialization && descriptor.fork.materialization !== undefined) {
    issue(errors, "/fork/materialization", "is only valid when forking an overlay source");
  }
  if (descriptor.fork.materialization !== undefined) {
    const materialization = descriptor.fork.materialization;
    if (checkObject(errors, materialization, "/fork/materialization", MATERIALIZATION)) {
      checkRequired(errors, materialization, "/fork/materialization", [
        "source_effective_fingerprint",
        "snapshot_fingerprint",
        "reviewed_at",
        "evidence",
      ]);
      checkFingerprint(
        errors,
        materialization.source_effective_fingerprint,
        "/fork/materialization/source_effective_fingerprint",
      );
      checkFingerprint(
        errors,
        materialization.snapshot_fingerprint,
        "/fork/materialization/snapshot_fingerprint",
      );
      checkPortableNonEmptyString(errors, materialization.reviewed_at, "/fork/materialization/reviewed_at", "review timestamp");
      checkPortableNonEmptyString(errors, materialization.evidence, "/fork/materialization/evidence", "review evidence");
      if (
        materialization.source_effective_fingerprint !== descriptor.source?.effective_fingerprint
      ) {
        issue(errors, "/fork/materialization/source_effective_fingerprint", "must equal source.effective_fingerprint");
      }
      if (materialization.snapshot_fingerprint !== descriptor.fork.snapshot_fingerprint) {
        issue(errors, "/fork/materialization/snapshot_fingerprint", "must equal fork.snapshot_fingerprint");
      }
    }
  }
}

/**
 * @param {unknown} descriptor
 * @returns {DescriptorValidationError[]}
 */
export function validateDescriptor(descriptor) {
  const errors = [];
  if (!checkObject(errors, descriptor, "", TOP_LEVEL)) return errors;
  checkRequired(errors, descriptor, "", [
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
  ]);
  if (descriptor.schema_version !== 1) issue(errors, "/schema_version", "must equal 1");
  if (descriptor.$schema !== undefined) {
    if (typeof descriptor.$schema !== "string") issue(errors, "/$schema", "must be a string when present");
    else if (isMachineAbsolutePath(descriptor.$schema)) issue(errors, "/$schema", "must not be a machine-local absolute path");
  }
  checkStableId(errors, descriptor.id, "/id");
  if (!["semantic-overlay", "fork"].includes(descriptor.type)) {
    issue(errors, "/type", "must be semantic-overlay or fork");
  }
  checkName(errors, descriptor.name, "/name");
  checkPortableNonEmptyString(errors, descriptor.license, "/license", "license identifier");
  for (const key of ["entrypoint", "customization"]) {
    if (!isPortableRelativePath(descriptor[key])) {
      issue(errors, `/${key}`, "must be a portable relative path");
    } else if (isOwnedPayloadExcludedPath(descriptor[key])) {
      issue(
        errors,
        `/${key}`,
        "must select a runtime-owned path outside customization.json, provenance/, and version-control metadata",
      );
    }
  }
  if (!Array.isArray(descriptor.dependencies)) {
    issue(errors, "/dependencies", "must be an array");
  } else {
    const seen = new Set();
    descriptor.dependencies.forEach((dependency, index) => {
      checkName(errors, dependency, `/dependencies/${index}`);
      if (seen.has(dependency)) issue(errors, `/dependencies/${index}`, "must be unique");
      seen.add(dependency);
    });
  }
  if (checkObject(errors, descriptor.owned_payload, "/owned_payload", OWNED_PAYLOAD)) {
    checkRequired(errors, descriptor.owned_payload, "/owned_payload", ["reviewed_fingerprint"]);
    checkFingerprint(errors, descriptor.owned_payload.reviewed_fingerprint, "/owned_payload/reviewed_fingerprint");
  }
  validateSource(descriptor.source, errors);
  validateActivation(descriptor, errors);
  validateFork(descriptor, errors);
  return errors;
}

/**
 * @param {unknown} descriptor
 * @returns {CustomizationDescriptor}
 */
export function assertValidDescriptor(descriptor) {
  const errors = validateDescriptor(descriptor);
  if (errors.length > 0) {
    throw new DescriptorError(
      `invalid customization descriptor: ${errors
        .map(({ path: pointer, message }) => `${pointer || "/"} ${message}`)
        .join("; ")}`,
      errors,
    );
  }
  return descriptor;
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function assertInventoryAvailable(descriptor, inventory) {
  for (const item of inventory ?? []) {
    if (item.id === descriptor.id && item.name !== descriptor.name) {
      throw new DescriptorError(`inventory collision: id ${descriptor.id} already belongs to ${item.name}`);
    }
    if (item.name === descriptor.name && item.id !== descriptor.id) {
      throw new DescriptorError(`inventory collision: name ${descriptor.name} already belongs to ${item.id}`);
    }
  }
}

function diagnostic({
  code,
  stage,
  message,
  causeCode,
  causeMessage,
  artifactKind,
  details,
}) {
  return {
    code,
    stage,
    message,
    ...(causeCode ? { causeCode } : {}),
    ...(causeMessage ? { causeMessage } : {}),
    ...(artifactKind ? { artifactKind } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * @param {DescriptorDiagnostic} value
 * @returns {DescriptorIngestionFailure}
 */
function failed(value) {
  return /** @type {DescriptorIngestionFailure} */ (freezeDeep({
    ok: false,
    checked: null,
    diagnostics: [value],
  }));
}

/**
 * @param {CheckedDescriptor} value
 * @returns {DescriptorIngestionSuccess}
 */
function successfulIngestion(value) {
  return /** @type {DescriptorIngestionSuccess} */ (freezeDeep({
    ok: true,
    checked: value,
    diagnostics: [],
  }));
}

async function descriptorFileArtifact(descriptorPath, displayPath = descriptorPath) {
  let info;
  try {
    info = await lstat(descriptorPath);
  } catch (error) {
    return {
      error: diagnostic({
        code: "DESCRIPTOR_READ_ERROR",
        stage: "read",
        message: `cannot read descriptor ${displayPath}: ${error.message}`,
        causeCode: error.code,
        causeMessage: error.message,
      }),
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      error: diagnostic({
        code: "DESCRIPTOR_ARTIFACT_INVALID",
        stage: "artifact",
        artifactKind: "descriptor",
        message: `descriptor path has invalid artifact type: ${displayPath} must be a regular file`,
        details: [{
          path: descriptorPath,
          message: "descriptor must be a regular file and may not be a symbolic link",
        }],
      }),
    };
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(descriptorPath);
  } catch (error) {
    return {
      error: diagnostic({
        code: "DESCRIPTOR_READ_ERROR",
        stage: "read",
        message: `cannot read descriptor ${displayPath}: ${error.message}`,
        causeCode: error.code,
        causeMessage: error.message,
      }),
    };
  }
  return {
    artifact: {
      kind: "descriptor",
      type: "file",
      relative: path.basename(descriptorPath),
      path: descriptorPath,
      canonicalPath,
    },
  };
}

async function inspectArtifact({
  root,
  kind,
  relative,
  expectedType,
  rejectExcludedRoots = false,
}) {
  let owned;
  try {
    owned = await resolveOwnedPath(root, relative, {
      rejectExcludedRoots,
      rejectSymlinks: true,
    });
  } catch (error) {
    throw new DescriptorError(
      `descriptor path is not owned: ${relative}: ${error.message}`,
      [{ path: `/${kind}`, message: error.message }],
    );
  }
  let info;
  try {
    info = await lstat(owned);
  } catch (error) {
    throw new DescriptorError(
      `descriptor path is not readable: ${relative}: ${error.message}`,
      [{ path: `/${kind}`, message: error.message }],
    );
  }
  const validType = expectedType === "directory"
    ? info.isDirectory()
    : info.isFile();
  if (!validType) {
    throw new DescriptorError(
      `descriptor path has invalid artifact type: ${relative} must be ${
        expectedType === "directory" ? "a snapshot directory" : "a regular file"
      }`,
      [{
        path: `/${kind}`,
        message: `must be ${expectedType === "directory" ? "a snapshot directory" : "a regular file"}`,
      }],
    );
  }
  return {
    kind,
    type: expectedType,
    relative,
    path: path.join(root, relative),
    canonicalPath: owned,
  };
}

function diagnosticFromError(error, stage = "validation") {
  return diagnostic({
    code: error.code ?? "INVALID_DESCRIPTOR",
    stage,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
}

/**
 * Parse and deeply check one Customization Descriptor and its owned runtime
 * artifacts. This is the single filesystem ingestion seam used by Discovery,
 * Binding, and Preflight. It does not discover sources or compute fingerprints.
 *
 * The result is detached and deeply immutable. Expected read, validation, and
 * artifact failures are returned as diagnostics so callers can preserve their
 * own error vocabulary without implementing a second reader.
 *
 * @param {DescriptorInput} input
 * @returns {Promise<DescriptorIngestion>}
 */
export async function ingestDescriptor({ descriptorPath, inventory = [] } = {}) {
  if (typeof descriptorPath !== "string" || !descriptorPath.trim()) {
    return failed(diagnostic({
      code: "INVALID_DESCRIPTOR_INPUT",
      stage: "input",
      message: "descriptorPath must be a non-empty path",
    }));
  }
  if (!Array.isArray(inventory)) {
    return failed(diagnostic({
      code: "INVALID_DESCRIPTOR_INPUT",
      stage: "input",
      message: "inventory must be an array",
    }));
  }

  const absoluteDescriptorPath = path.resolve(descriptorPath);
  const descriptorFile = await descriptorFileArtifact(absoluteDescriptorPath, descriptorPath);
  if (descriptorFile.error) return failed(descriptorFile.error);

  let contents;
  try {
    contents = await readFile(absoluteDescriptorPath, "utf8");
  } catch (error) {
    return failed(diagnostic({
      code: "DESCRIPTOR_READ_ERROR",
      stage: "read",
      message: `cannot read descriptor ${descriptorPath}: ${error.message}`,
      causeCode: error.code,
      causeMessage: error.message,
    }));
  }

  let descriptor;
  try {
    descriptor = JSON.parse(contents);
  } catch (error) {
    return failed(diagnostic({
      code: "DESCRIPTOR_READ_ERROR",
      stage: "parse",
      message: `cannot read descriptor ${descriptorPath}: ${error.message}`,
      causeCode: "JSON_PARSE_ERROR",
      causeMessage: error.message,
    }));
  }

  const validationErrors = validateDescriptor(descriptor);
  if (validationErrors.length > 0) {
    return failed(diagnostic({
      code: "INVALID_DESCRIPTOR",
      stage: "validation",
      message: `invalid customization descriptor: ${validationErrors
        .map(({ path: pointer, message }) => `${pointer || "/"} ${message}`)
        .join("; ")}`,
      details: validationErrors,
    }));
  }

  const root = path.dirname(absoluteDescriptorPath);
  const actualFolder = path.basename(root);
  if (descriptor.name !== actualFolder) {
    return failed(diagnostic({
      code: "INVALID_DESCRIPTOR",
      stage: "folder",
      message: `descriptor name ${descriptor.name} does not match folder name ${actualFolder}`,
      details: [{
        path: "/name",
        message: "must match its directory name",
      }],
    }));
  }

  try {
    assertInventoryAvailable(descriptor, inventory);
  } catch (error) {
    return failed(diagnosticFromError(error, "inventory"));
  }

  const referenced = [
    {
      kind: "entrypoint",
      relative: descriptor.entrypoint,
      rejectExcludedRoots: true,
      expectedType: "file",
    },
    {
      kind: "customization",
      relative: descriptor.customization,
      rejectExcludedRoots: true,
      expectedType: "file",
    },
    ...(descriptor.type === "fork"
      ? [
          {
            kind: "snapshot",
            relative: descriptor.fork.snapshot,
            expectedType: "directory",
          },
          {
            kind: "diff",
            relative: descriptor.fork.diff,
            expectedType: "file",
          },
        ]
      : []),
  ];
  const artifacts = [descriptorFile.artifact];
  try {
    for (const reference of referenced) {
      artifacts.push(await inspectArtifact({ root, ...reference }));
    }
  } catch (error) {
    return failed(diagnosticFromError(error, "artifact"));
  }

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    return failed(diagnostic({
      code: "DESCRIPTOR_READ_ERROR",
      stage: "read",
      message: `cannot read descriptor folder ${root}: ${error.message}`,
      causeCode: error.code,
      causeMessage: error.message,
    }));
  }

  return successfulIngestion({
    descriptor: freezeDeep(structuredClone(descriptor)),
    location: {
      descriptorPath: absoluteDescriptorPath,
      root,
      canonicalRoot,
    },
    artifacts,
  });
}

function descriptorErrorFromIngestion(result) {
  const first = result.diagnostics[0] ?? diagnostic({
    code: "INVALID_DESCRIPTOR",
    stage: "validation",
    message: "invalid customization descriptor",
  });
  return new DescriptorError(first.message, first.details);
}

/**
 * @param {string} descriptorPath
 * @param {{inventory?: readonly DescriptorInventoryRecord[]}} [options]
 * @returns {Promise<CheckedDescriptor>}
 */
export async function readCheckedDescriptor(descriptorPath, { inventory = [] } = {}) {
  const result = await ingestDescriptor({ descriptorPath, inventory });
  if (!result.ok) throw descriptorErrorFromIngestion(result);
  return result.checked;
}

/**
 * Compatibility adapter returning the checked portable descriptor record.
 * Filesystem parsing and artifact inspection remain owned by ingestDescriptor.
 *
 * @param {string} descriptorPath
 * @param {{inventory?: readonly DescriptorInventoryRecord[]}} [options]
 * @returns {Promise<Readonly<CustomizationDescriptor>>}
 */
export async function readDescriptor(descriptorPath, options = {}) {
  return (await readCheckedDescriptor(descriptorPath, options)).descriptor;
}
