import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DESCRIPTOR_INVARIANTS } from "./descriptor-invariants.js";
import { assertValidDescriptor } from "./descriptor.js";
import { ReconciliationError } from "./errors.js";
import {
  fingerprintFile,
  fingerprintPath,
  fingerprintValues,
  payloadFingerprint,
} from "./fingerprint.js";
import { generateLocalIdentity } from "./normalization.js";
import {
  isSourceFingerprintExcludedPath,
  isVersionControlMetadataPath,
} from "./owned-payload.js";
import { resolveOwnedPath, statePathExclusions } from "./paths.js";
import { readJsonState, updateJsonAtomic } from "./state.js";

const EMPTY_CACHE = { version: 1, compatibility: {} };
const FINGERPRINT = new RegExp(DESCRIPTOR_INVARIANTS.patterns.fingerprint.source);

export function compatibilityCachePath({ env = process.env, home = os.homedir() } = {}) {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "skill-customization", "compatibility.json")
    : path.join(home, ".agents", "skill-customization", "compatibility.json");
}

async function sourceLocation(sourcePath) {
  if (!sourcePath) {
    throw new ReconciliationError("semantic overlays require a live source", {
      code: "LIVE_SOURCE_REQUIRED",
    });
  }
  let resolved;
  let info;
  try {
    resolved = await realpath(sourcePath);
    info = await lstat(resolved);
  } catch {
    throw new ReconciliationError(`live source is unavailable: ${sourcePath}`, {
      code: "LIVE_SOURCE_REQUIRED",
    });
  }
  const root = info.isDirectory() ? resolved : path.dirname(resolved);
  const entrypoint = info.isDirectory() ? path.join(root, "SKILL.md") : resolved;
  try {
    const entrypointInfo = await lstat(entrypoint);
    if (entrypointInfo.isSymbolicLink()) throw new Error("symbolic link");
    if (!entrypointInfo.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new ReconciliationError(
      `live source entrypoint is unavailable: ${entrypoint}: ${error.message}`,
      { code: "LIVE_SOURCE_REQUIRED" },
    );
  }
  return { entrypoint, root };
}

function sourceCheckpoint(
  descriptor,
  sourceFingerprint,
  sourceIdentityFingerprint = sourceFingerprint,
) {
  const sourceIdentity = generateLocalIdentity({
    skillName: descriptor.source.skill_name,
    fingerprint: sourceIdentityFingerprint,
  });
  const expected = descriptor.source.effective_fingerprint;
  const actual = sourceFingerprint;
  return { expected, actual, sourceIdentity, match: actual === expected };
}

function baseResult(
  descriptor,
  sourceFingerprint,
  customizationFingerprint,
  sourceIdentityFingerprint,
) {
  const checkpoint = sourceCheckpoint(
    descriptor,
    sourceFingerprint,
    sourceIdentityFingerprint,
  );
  return {
    customization: descriptor.id,
    type: descriptor.type,
    sourceFingerprint,
    customizationFingerprint,
    checkpointFingerprint: checkpoint.expected,
    ...(descriptor.source.kind === "local"
      ? { sourceIdentity: checkpoint.sourceIdentity }
      : {}),
    checkpointMatch: checkpoint.match,
    stopped: false,
    cached: false,
    flags: { ambiguousDrift: false, absorbedDeltas: [] },
  };
}

async function forkSnapshotEntrypoint(snapshot) {
  const info = await lstat(snapshot);
  if (!info.isDirectory()) {
    throw new Error("fork snapshot must be a directory");
  }
  const entrypoint = path.join(snapshot, "SKILL.md");
  const entrypointInfo = await lstat(entrypoint).catch(() => undefined);
  if (!entrypointInfo?.isFile()) {
    throw new Error("fork snapshot directory must contain SKILL.md");
  }
  return entrypoint;
}

function structuralDiffLine(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function diffPath(header, prefix) {
  const value = structuralDiffLine(header)
    .slice(4)
    .split("\t", 1)[0]
    .trim();
  if (value === "/dev/null") return null;
  if (!value || value.startsWith('"')) {
    throw new Error("fork diff uses an unsupported or missing file path");
  }
  const relative = value.startsWith(`${prefix}/`)
    ? value.slice(prefix.length + 1)
    : value;
  const parts = relative.split("/");
  if (
    relative.includes("\\")
    || relative.includes("\0")
    || path.posix.isAbsolute(relative)
    || /^[A-Za-z]:[\\/]/.test(relative)
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`fork diff path is not a safe relative path: ${value}`);
  }
  return parts.join("/");
}

function parseHunkHeader(line) {
  const match = structuralDiffLine(line).match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/,
  );
  if (!match) return undefined;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    (oldCount > 0 && oldStart === 0)
    || (newCount > 0 && newStart === 0)
  ) {
    throw new Error("fork diff has an invalid zero hunk position");
  }
  return { oldStart, oldCount, newStart, newCount };
}

function parseUnifiedDiff(contents) {
  if (!contents.trim()) throw new Error("fork diff must not be empty");
  const lines = contents.split("\n");
  const patches = [];
  let index = 0;
  while (index < lines.length) {
    const oldHeader = structuralDiffLine(lines[index]);
    const newHeader = structuralDiffLine(lines[index + 1] ?? "");
    if (!oldHeader.startsWith("--- ") || !newHeader.startsWith("+++ ")) {
      index += 1;
      continue;
    }
    const patch = {
      oldPath: diffPath(oldHeader, "a"),
      newPath: diffPath(newHeader, "b"),
      hunks: [],
    };
    if (!patch.oldPath && !patch.newPath) {
      throw new Error("fork diff cannot patch /dev/null to /dev/null");
    }
    index += 2;
    let hasChange = false;
    while (index < lines.length) {
      const line = structuralDiffLine(lines[index]);
      if (
        line.startsWith("diff --git ")
        || (
          line.startsWith("--- ")
          && structuralDiffLine(lines[index + 1] ?? "").startsWith("+++ ")
        )
      ) {
        break;
      }
      if (!line) {
        index += 1;
        continue;
      }
      const header = parseHunkHeader(line);
      if (!header) {
        throw new Error(`fork diff has unexpected content outside a hunk: ${line}`);
      }
      index += 1;
      const operations = [];
      let oldLines = 0;
      let newLines = 0;
      while (oldLines < header.oldCount || newLines < header.newCount) {
        if (index >= lines.length) {
          throw new Error("fork diff hunk ended before its declared line counts");
        }
        const raw = lines[index];
        const kind = raw[0];
        if (![" ", "-", "+"].includes(kind)) {
          throw new Error("fork diff hunk contains an invalid line");
        }
        const operation = { kind, text: raw.slice(1), newline: true };
        operations.push(operation);
        if (kind !== "+") oldLines += 1;
        if (kind !== "-") newLines += 1;
        if (kind !== " ") hasChange = true;
        if (oldLines > header.oldCount || newLines > header.newCount) {
          throw new Error("fork diff hunk exceeds its declared line counts");
        }
        index += 1;
        if (
          structuralDiffLine(lines[index] ?? "")
          === "\\ No newline at end of file"
        ) {
          operation.newline = false;
          index += 1;
        }
      }
      patch.hunks.push({ ...header, operations });
    }
    const headerOnlyStructuralChange =
      patch.hunks.length === 0
      && (patch.oldPath === null || patch.newPath === null);
    if (!headerOnlyStructuralChange && (patch.hunks.length === 0 || !hasChange)) {
      throw new Error("fork diff file must contain a hunk with changed lines");
    }
    patches.push(patch);
  }
  if (patches.length === 0) {
    throw new Error("fork diff must contain unified file headers and hunks");
  }
  const targets = new Set();
  for (const patch of patches) {
    const target = patch.newPath ?? patch.oldPath;
    if (targets.has(target)) {
      throw new Error(`fork diff repeats target path ${target}`);
    }
    targets.add(target);
  }
  return patches;
}

function splitTextLines(contents) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") {
      lines.push(contents.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < contents.length) lines.push(contents.slice(start));
  return lines;
}

function applyUnifiedFilePatch(contents, patch) {
  const source = splitTextLines(contents);
  const output = [];
  let sourceIndex = 0;
  for (const hunk of patch.hunks) {
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (
      oldIndex < sourceIndex
      || oldIndex > source.length
      || newIndex !== output.length + (oldIndex - sourceIndex)
    ) {
      throw new Error(`fork diff does not apply cleanly at ${patch.oldPath ?? patch.newPath}`);
    }
    output.push(...source.slice(sourceIndex, oldIndex));
    sourceIndex = oldIndex;
    for (const operation of hunk.operations) {
      const line = `${operation.text}${operation.newline ? "\n" : ""}`;
      if (operation.kind !== "+") {
        if (source[sourceIndex] !== line) {
          throw new Error(`fork diff does not apply to snapshot at ${patch.oldPath}`);
        }
        sourceIndex += 1;
      }
      if (operation.kind !== "-") output.push(line);
    }
  }
  output.push(...source.slice(sourceIndex));
  return output.join("");
}

function portableRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isExcludedPayloadPath(relativePath, excludedPaths) {
  return excludedPaths.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

async function mapDirectoryPayload(
  root,
  {
    excludedPaths = [],
    label = "fork payload",
    excludeSourceMetadata = false,
  } = {},
) {
  const payload = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = portableRelative(root, absolutePath);
      const metadataExcluded = excludeSourceMetadata
        ? isSourceFingerprintExcludedPath(relativePath)
        : isVersionControlMetadataPath(relativePath);
      if (
        metadataExcluded
        || isExcludedPayloadPath(relativePath, excludedPaths)
      ) continue;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw new Error(`${label} contains symbolic link at ${relativePath}`);
      }
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        payload.set(relativePath, await readFile(absolutePath));
      } else {
        throw new Error(`${label} contains unsupported file type at ${relativePath}`);
      }
    }
  }
  await visit(root);
  return payload;
}

function assertPayloadPathShape(payload, candidatePath) {
  for (const existingPath of payload.keys()) {
    if (
      existingPath !== candidatePath
      && (
        existingPath.startsWith(`${candidatePath}/`)
        || candidatePath.startsWith(`${existingPath}/`)
      )
    ) {
      throw new Error(
        `fork diff creates a file/directory path conflict between ${candidatePath} and ${existingPath}`,
      );
    }
  }
}

function decodePatchSource(buffer, relativePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`fork diff target is not UTF-8 text: ${relativePath}`);
  }
}

function applyPatchesToPayload(payload, patches) {
  const reconstructed = new Map(payload);
  for (const patch of patches) {
    let source = "";
    if (patch.oldPath) {
      const sourceBuffer = reconstructed.get(patch.oldPath);
      if (!sourceBuffer) {
        throw new Error(
          `fork diff does not apply; snapshot path is missing: ${patch.oldPath}`,
        );
      }
      source = decodePatchSource(sourceBuffer, patch.oldPath);
      if (
        patch.newPath
        && patch.newPath !== patch.oldPath
        && reconstructed.has(patch.newPath)
      ) {
        throw new Error(
          `fork diff rename destination already exists in snapshot: ${patch.newPath}`,
        );
      }
    } else if (reconstructed.has(patch.newPath)) {
      throw new Error(`fork diff new file already exists in snapshot: ${patch.newPath}`);
    }

    const patched = applyUnifiedFilePatch(source, patch);
    if (patch.oldPath) reconstructed.delete(patch.oldPath);
    if (patch.newPath) {
      assertPayloadPathShape(reconstructed, patch.newPath);
      reconstructed.set(patch.newPath, Buffer.from(patched, "utf8"));
    } else if (patched !== "") {
      throw new Error(`fork diff deletion leaves content at ${patch.oldPath}`);
    }
  }
  return reconstructed;
}

function compareForkPayloads(reconstructed, owned) {
  for (const [relativePath, ownedContents] of owned) {
    const reconstructedContents = reconstructed.get(relativePath);
    if (!reconstructedContents) {
      throw new Error(`unrepresented payload file ${relativePath}`);
    }
    if (!reconstructedContents.equals(ownedContents)) {
      throw new Error(`reconstructed fork does not match owned fork payload at ${relativePath}`);
    }
  }
  for (const relativePath of reconstructed.keys()) {
    if (!owned.has(relativePath)) {
      throw new Error(`owned fork payload is missing reconstructed file ${relativePath}`);
    }
  }
}

async function verifyForkDiff({
  contents,
  snapshot,
  customizationRoot,
  excludedPaths,
}) {
  const patches = parseUnifiedDiff(contents);
  const snapshotPayload = await mapDirectoryPayload(snapshot, {
    label: "fork snapshot",
    excludeSourceMetadata: true,
  });
  const reconstructed = applyPatchesToPayload(snapshotPayload, patches);
  const owned = await mapDirectoryPayload(customizationRoot, {
    excludedPaths,
    label: "owned fork payload",
  });
  compareForkPayloads(reconstructed, owned);
  return patches.map((patch) => patch.newPath ?? patch.oldPath);
}

function reconcileOutcome(base, outcome) {
  if (Array.isArray(outcome)) {
    const normalized = outcome.map((item) => JSON.stringify(item));
    if (new Set(normalized).size !== 1) {
      return {
        ...base,
        status: "ambiguous-drift",
        stopped: true,
        flags: { ambiguousDrift: true, absorbedDeltas: [] },
      };
    }
    outcome = outcome[0];
  }
  if (!outcome || outcome.ambiguous) {
    return {
      ...base,
      status: "ambiguous-drift",
      stopped: true,
      flags: { ambiguousDrift: true, absorbedDeltas: [] },
    };
  }
  const absorbedDeltas = Array.isArray(outcome.absorbedDeltas)
    ? outcome.absorbedDeltas
    : [];
  if (absorbedDeltas.length > 0) {
    return {
      ...base,
      status: "absorbed-delta",
      stopped: true,
      evidence: outcome.evidence,
      flags: { ambiguousDrift: false, absorbedDeltas },
    };
  }
  if (outcome.compatible === true) {
    return { ...base, status: "compatible", evidence: outcome.evidence };
  }
  return {
    ...base,
    status: "incompatible",
    stopped: true,
    evidence: outcome.evidence,
  };
}

async function readCompatibility(
  cachePath,
  descriptorId,
  fingerprint,
  customizationFingerprint,
  executionFingerprint,
) {
  if (!cachePath) return undefined;
  const cache = await readJsonState(cachePath, EMPTY_CACHE);
  assertCompatibilityCache(cache, cachePath);
  const cached = cache.compatibility[descriptorId]?.[fingerprint];
  return (
    cached?.customizationFingerprint === customizationFingerprint
    && cached.executionFingerprint === executionFingerprint
  )
    ? { status: cached.status, evidence: cached.evidence }
    : undefined;
}

function assertCompatibilityCache(cache, cachePath) {
  if (
    cache?.version !== 1
    || !cache.compatibility
    || typeof cache.compatibility !== "object"
    || Array.isArray(cache.compatibility)
  ) {
    throw new ReconciliationError(`invalid compatibility cache ${cachePath}`, {
      code: "INVALID_COMPATIBILITY_CACHE",
    });
  }
}

async function cacheCompatibility(
  cachePath,
  descriptorId,
  fingerprint,
  customizationFingerprint,
  executionFingerprint,
  result,
) {
  if (!cachePath) return;
  await updateJsonAtomic(cachePath, EMPTY_CACHE, (cache) => {
    assertCompatibilityCache(cache, cachePath);
    cache.compatibility[descriptorId] ??= {};
    cache.compatibility[descriptorId][fingerprint] = {
      status: result.status,
      evidence: result.evidence,
      customizationFingerprint,
      executionFingerprint,
    };
    return cache;
  });
}

function overlayCompatibilityFingerprint(descriptor, ownedFingerprint) {
  return fingerprintValues(
    [descriptor.id, "delta", descriptor.customization, ownedFingerprint],
    "skill-customization-overlay-compatibility-v1",
  );
}

function checkedCustomizationSourcePlan(sourceExecutionPlan) {
  if (
    !Array.isArray(sourceExecutionPlan)
    || sourceExecutionPlan.length === 0
    || sourceExecutionPlan.some((step, index) => (
      !step
      || typeof step !== "object"
      || step.role !== (index === 0 ? "workflow" : "delta")
      || typeof step.path !== "string"
      || !path.isAbsolute(step.path)
      || typeof step.root !== "string"
      || !path.isAbsolute(step.root)
      || (index === 0
        ? step.customizationId !== null && typeof step.customizationId !== "string"
        : typeof step.customizationId !== "string" || !step.customizationId)
    ))
  ) {
    throw new ReconciliationError(
      "semantic review of a customization source requires its checked execution plan",
      { code: "CUSTOMIZATION_SOURCE_EXECUTION_PLAN_REQUIRED" },
    );
  }
  return structuredClone(sourceExecutionPlan);
}

async function reconcileOverlay({
  descriptor,
  customizationRoot,
  sourcePath,
  sourceEffectiveFingerprint,
  sourceExecutionPlan,
  statePath,
  cachePath = compatibilityCachePath(),
  semanticReconciler,
}) {
  const { entrypoint, root: sourceRoot } = await sourceLocation(sourcePath);
  const customizationEntrypoint = await resolveOwnedPath(
    customizationRoot,
    descriptor.entrypoint,
  ).catch((error) => {
    throw new ReconciliationError(
      `customization entrypoint is not owned: ${error.message}`,
      { code: "CUSTOMIZATION_PATH_NOT_OWNED" },
    );
  });
  const customizationInstructions = await resolveOwnedPath(
    customizationRoot,
    descriptor.customization,
  ).catch((error) => {
    throw new ReconciliationError(
      `customization instructions are not owned: ${error.message}`,
      { code: "CUSTOMIZATION_PATH_NOT_OWNED" },
    );
  });
  if (
    descriptor.source.kind === "customization"
    && !FINGERPRINT.test(sourceEffectiveFingerprint ?? "")
  ) {
    throw new ReconciliationError(
      "customization sources require their checked effective fingerprint",
      { code: "CUSTOMIZATION_SOURCE_EFFECTIVE_FINGERPRINT_REQUIRED" },
    );
  }
  const sourceFingerprint = descriptor.source.kind === "customization"
    ? sourceEffectiveFingerprint
    : await fingerprintPath(sourceRoot, {
        excludedPaths: statePathExclusions(statePath),
      });
  const sourceIdentityFingerprint = descriptor.source.kind === "local"
    ? await fingerprintFile(entrypoint)
    : undefined;
  const customizationFingerprint = await payloadFingerprint(customizationRoot);
  const compatibilityFingerprint = overlayCompatibilityFingerprint(
    descriptor,
    customizationFingerprint,
  );
  const base = baseResult(
    descriptor,
    sourceFingerprint,
    customizationFingerprint,
    sourceIdentityFingerprint,
  );
  if (
    customizationFingerprint !== descriptor.owned_payload.reviewed_fingerprint
  ) {
    return {
      ...base,
      status: "owned-payload-drift",
      stopped: true,
      flags: { ambiguousDrift: false, absorbedDeltas: [] },
    };
  }
  if (base.checkpointMatch) return { ...base, status: "compatible" };

  const cached = await readCompatibility(
    cachePath,
    descriptor.id,
    sourceFingerprint,
    customizationFingerprint,
    compatibilityFingerprint,
  );
  if (cached?.status === "compatible") {
    return { ...base, ...cached, cached: true };
  }
  if (typeof semanticReconciler !== "function") {
    return reconcileOutcome(base, { ambiguous: true });
  }
  const checkedSourcePlan = descriptor.source.kind === "customization"
    ? checkedCustomizationSourcePlan(sourceExecutionPlan)
    : undefined;
  const outcome = await semanticReconciler({
    descriptor,
    sourceEntrypoint: checkedSourcePlan?.[0].path ?? entrypoint,
    sourceFingerprint,
    ...(checkedSourcePlan
      ? { sourceExecutionPlan: checkedSourcePlan }
      : {}),
    customizationEntrypoint,
    customizationInstructions,
  });
  const result = reconcileOutcome(base, outcome);
  if (result.status === "compatible") {
    await cacheCompatibility(
      cachePath,
      descriptor.id,
      sourceFingerprint,
      customizationFingerprint,
      compatibilityFingerprint,
      result,
    );
  }
  return result;
}

async function reconcileFork({ descriptor, customizationRoot }) {
  try {
    const snapshot = await resolveOwnedPath(
      customizationRoot,
      descriptor.fork.snapshot,
      { rejectSymlinks: true },
    );
    const diff = await resolveOwnedPath(customizationRoot, descriptor.fork.diff, {
      rejectSymlinks: true,
    });
    const entrypoint = await resolveOwnedPath(
      customizationRoot,
      descriptor.entrypoint,
    );
    const snapshotEntrypoint = await forkSnapshotEntrypoint(snapshot);
    const snapshotFingerprint = await fingerprintPath(snapshot);
    const diffFingerprint = await fingerprintFile(diff);
    const ownedFingerprint = await payloadFingerprint(customizationRoot);
    if (snapshotFingerprint !== descriptor.fork.snapshot_fingerprint) {
      throw new Error("fork snapshot fingerprint does not match its reviewed descriptor fingerprint");
    }
    if (
      descriptor.source.kind !== "customization"
      && snapshotFingerprint !== descriptor.source.effective_fingerprint
    ) {
      throw new Error("fork snapshot fingerprint does not match the reviewed full-source effective fingerprint");
    }
    if (diffFingerprint !== descriptor.fork.diff_fingerprint) {
      throw new Error("fork diff fingerprint does not match its reviewed descriptor fingerprint");
    }
    if (ownedFingerprint !== descriptor.owned_payload.reviewed_fingerprint) {
      throw new Error("fork owned payload fingerprint does not match its reviewed descriptor fingerprint");
    }
    const diffTargets = await verifyForkDiff({
      contents: await readFile(diff, "utf8"),
      snapshot,
      customizationRoot,
      excludedPaths: [
        "customization.json",
        "provenance",
      ],
    });
    return {
      customization: descriptor.id,
      type: descriptor.type,
      status: "fork-ready",
      runtimeSourceRequired: false,
      stopped: false,
      provenance: {
        source: descriptor.source,
        snapshotFingerprint,
        snapshotEntrypointFingerprint: await fingerprintFile(snapshotEntrypoint),
        diffFingerprint,
        diffTargets,
        ownedPayloadFingerprint: ownedFingerprint,
        forkFingerprint: await fingerprintFile(entrypoint),
      },
    };
  } catch (error) {
    throw new ReconciliationError(`fork provenance is incomplete: ${error.message}`, {
      code: "INCOMPLETE_FORK_PROVENANCE",
    });
  }
}

export async function reconcileCustomization(options) {
  const { descriptor, customizationRoot } = options;
  assertValidDescriptor(descriptor);
  if (!customizationRoot) {
    throw new ReconciliationError("customizationRoot is required", {
      code: "CUSTOMIZATION_ROOT_REQUIRED",
    });
  }
  return descriptor.type === "fork"
    ? reconcileFork(options)
    : reconcileOverlay(options);
}
