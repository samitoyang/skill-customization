import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { DescriptorError } from "./errors.js";
import { normalizeRepositoryUrl } from "./normalization.js";
import { isMachineAbsolutePath, resolveOwnedPath } from "./paths.js";

const TOP_LEVEL = new Set([
  "$schema",
  "schema_version",
  "id",
  "type",
  "name",
  "entrypoint",
  "customization",
  "dependencies",
  "source",
  "activation",
  "fork",
]);
const SOURCE_COMMON = new Set(["skill_name", "kind"]);
const REPOSITORY_SOURCE = new Set([
  ...SOURCE_COMMON,
  "repository",
  "upstream_path",
  "license",
  "review",
]);
const LOCAL_SOURCE = new Set([...SOURCE_COMMON, "identity"]);
const ACTIVATION = new Set(["mode", "precedence"]);
const REVIEW = new Set(["revision", "fingerprint"]);
const FORK = new Set(["snapshot", "diff"]);
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

function checkPortableNonEmptyString(errors, value, pointer, label) {
  if (typeof value !== "string" || !value.trim()) {
    issue(errors, pointer, `must be a non-empty ${label}`);
  } else if (isMachineAbsolutePath(value)) {
    issue(errors, pointer, "must not be a machine-local absolute path");
  }
}

export function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.split("/");
  return !parts.includes("..") && !parts.includes("") && value !== ".";
}

function validateSource(source, errors) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    issue(errors, "/source", "must be an object");
    return;
  }
  const allowed =
    source.kind === "repository"
      ? REPOSITORY_SOURCE
      : source.kind === "local"
        ? LOCAL_SOURCE
        : SOURCE_COMMON;
  checkObject(errors, source, "/source", allowed);
  checkRequired(errors, source, "/source", ["skill_name", "kind"]);
  checkName(errors, source.skill_name, "/source/skill_name");

  if (source.kind === "repository") {
    checkRequired(errors, source, "/source", [
      "repository",
      "upstream_path",
      "license",
      "review",
    ]);
    let canonicalRepository = false;
    try {
      const url = new URL(source.repository);
      canonicalRepository =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        normalizeRepositoryUrl(source.repository) === source.repository;
    } catch {
      canonicalRepository = false;
    }
    if (!canonicalRepository) {
      issue(errors, "/source/repository", "must be a credential-free HTTPS repository URL");
    }
    if (!isPortableRelativePath(source.upstream_path)) {
      issue(errors, "/source/upstream_path", "must be a portable relative path");
    }
    checkPortableNonEmptyString(
      errors,
      source.license,
      "/source/license",
      "license identifier",
    );
    if (checkObject(errors, source.review, "/source/review", REVIEW)) {
      checkRequired(errors, source.review, "/source/review", [
        "revision",
        "fingerprint",
      ]);
      checkPortableNonEmptyString(
        errors,
        source.review.revision,
        "/source/review/revision",
        "review revision",
      );
      if (!FINGERPRINT.test(source.review.fingerprint ?? "")) {
        issue(
          errors,
          "/source/review/fingerprint",
          "must be sha256 followed by 64 lowercase hex characters",
        );
      }
    }
  } else if (source.kind === "local") {
    checkRequired(errors, source, "/source", ["identity"]);
    if (!LOCAL_IDENTITY.test(source.identity ?? "")) {
      issue(
        errors,
        "/source/identity",
        "must be a generated local:sha256 identity, never a filesystem path",
      );
    }
  } else {
    issue(errors, "/source/kind", "must be repository or local");
  }
}

export function validateDescriptor(descriptor) {
  const errors = [];
  if (!checkObject(errors, descriptor, "", TOP_LEVEL)) return errors;
  checkRequired(errors, descriptor, "", [
    "schema_version",
    "id",
    "type",
    "name",
    "entrypoint",
    "customization",
    "dependencies",
    "source",
    "activation",
  ]);
  if (descriptor.schema_version !== 1) {
    issue(errors, "/schema_version", "must equal 1");
  }
  if (descriptor.$schema !== undefined) {
    if (typeof descriptor.$schema !== "string") {
      issue(errors, "/$schema", "must be a string when present");
    } else if (isMachineAbsolutePath(descriptor.$schema)) {
      issue(errors, "/$schema", "must not be a machine-local absolute path");
    }
  }
  if (
    typeof descriptor.id !== "string" ||
    !STABLE_ID.test(descriptor.id) ||
    isMachineAbsolutePath(descriptor.id)
  ) {
    issue(errors, "/id", "must be a stable absolute URI such as a URN");
  }
  if (!["semantic-overlay", "fork"].includes(descriptor.type)) {
    issue(errors, "/type", "must be semantic-overlay or fork");
  }
  checkName(errors, descriptor.name, "/name");
  for (const key of ["entrypoint", "customization"]) {
    if (!isPortableRelativePath(descriptor[key])) {
      issue(errors, `/${key}`, "must be a portable relative path");
    }
  }
  if (!Array.isArray(descriptor.dependencies)) {
    issue(errors, "/dependencies", "must be an array");
  } else {
    const seen = new Set();
    descriptor.dependencies.forEach((dependency, index) => {
      checkName(errors, dependency, `/dependencies/${index}`);
      if (seen.has(dependency)) {
        issue(errors, `/dependencies/${index}`, "must be unique");
      }
      seen.add(dependency);
    });
  }
  validateSource(descriptor.source, errors);

  if (checkObject(errors, descriptor.activation, "/activation", ACTIVATION)) {
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
        issue(
          errors,
          "/activation/precedence",
          "replace mode requires deterministic customization-first precedence",
        );
      }
    }
  }

  if (descriptor.type === "fork") {
    if (checkObject(errors, descriptor.fork, "/fork", FORK)) {
      checkRequired(errors, descriptor.fork, "/fork", ["snapshot", "diff"]);
      for (const key of ["snapshot", "diff"]) {
        if (!isPortableRelativePath(descriptor.fork[key])) {
          issue(errors, `/fork/${key}`, "must be a portable relative path");
        }
      }
    }
  } else if (descriptor.fork !== undefined) {
    issue(errors, "/fork", "is only valid for fork customizations");
  }

  return errors;
}

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

function assertInventoryAvailable(descriptor, inventory) {
  for (const item of inventory ?? []) {
    if (item.id === descriptor.id && item.name !== descriptor.name) {
      throw new DescriptorError(
        `inventory collision: id ${descriptor.id} already belongs to ${item.name}`,
      );
    }
    if (item.name === descriptor.name && item.id !== descriptor.id) {
      throw new DescriptorError(
        `inventory collision: name ${descriptor.name} already belongs to ${item.id}`,
      );
    }
  }
}

export async function readDescriptor(
  descriptorPath,
  { inventory = [] } = {},
) {
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  } catch (error) {
    throw new DescriptorError(`cannot read descriptor ${descriptorPath}: ${error.message}`);
  }
  assertValidDescriptor(descriptor);
  const actualFolder = path.basename(path.dirname(path.resolve(descriptorPath)));
  if (descriptor.name !== actualFolder) {
    throw new DescriptorError(
      `descriptor name ${descriptor.name} does not match folder name ${actualFolder}`,
    );
  }
  assertInventoryAvailable(descriptor, inventory);
  const root = path.dirname(path.resolve(descriptorPath));
  const referenced = [
    {
      relative: descriptor.entrypoint,
      rejectSymlinks: false,
      expectedType: "file",
    },
    {
      relative: descriptor.customization,
      rejectSymlinks: false,
      expectedType: "file",
    },
    ...(descriptor.type === "fork"
      ? [
          {
            relative: descriptor.fork.snapshot,
            rejectSymlinks: true,
            expectedType: "snapshot",
          },
          {
            relative: descriptor.fork.diff,
            rejectSymlinks: true,
            expectedType: "file",
          },
        ]
      : []),
  ];
  for (const { relative, rejectSymlinks, expectedType } of referenced) {
    const owned = await resolveOwnedPath(root, relative, { rejectSymlinks }).catch(
      (error) => {
        throw new DescriptorError(
          `descriptor path is not owned: ${relative}: ${error.message}`,
        );
      },
    );
    const info = await lstat(owned);
    const validType = expectedType === "snapshot"
      ? info.isFile() || info.isDirectory()
      : info.isFile();
    if (!validType) {
      throw new DescriptorError(
        `descriptor path has invalid artifact type: ${relative} must be ${
          expectedType === "snapshot" ? "a file or directory" : "a regular file"
        }`,
      );
    }
  }
  return descriptor;
}
