import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeRepositoryUrl } from "./normalization.js";
import { parseSkillMetadata } from "./skill-metadata.js";

const execFileAsync = promisify(execFile);

const MANAGER_OWNERS = Object.freeze({
  vercel: Object.freeze({ kind: "manager", manager: "vercel" }),
  asm: Object.freeze({ kind: "manager", manager: "asm" }),
  xing: Object.freeze({ kind: "manager", manager: "xing" }),
  jtianling: Object.freeze({ kind: "manager", manager: "jtianling" }),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(data, label) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new TypeError(`${label} must be valid JSON: ${error.message}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function directoryPath(skillPath) {
  const normalized = skillPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return /(^|\/)skill\.md$/i.test(normalized)
    ? path.posix.dirname(normalized) === "."
      ? ""
      : path.posix.dirname(normalized)
    : normalized.replace(/\/$/, "");
}

function repositoryFromExplicitSource(sourceType, sourceUrl, source) {
  if (!/^(?:github|git|gitlab|repository|skillssh)$/i.test(sourceType)) {
    return undefined;
  }
  const explicit = optionalString(sourceUrl) ?? optionalString(source);
  if (!explicit) return undefined;
  const locator = /^[\w.-]+\/[\w.-]+(?:(?:#|@).*)?$/.test(explicit)
    ? explicit.replace(/(?:#|@).*$/, "")
    : explicit;
  try {
    return normalizeRepositoryUrl(locator);
  } catch {
    return undefined;
  }
}

function rowsFromEnvelope(data, label) {
  const value = jsonValue(data, label);
  if (Array.isArray(value)) return value;
  if (!isObject(value)) {
    throw new TypeError(`${label} must contain an array of skills`);
  }
  for (const key of ["skills", "items", "records", "results"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data !== undefined) return rowsFromEnvelope(value.data, label);
  if (optionalString(value.name) || optionalString(value.dirName)) return [value];
  throw new TypeError(`${label} must contain an array of skills`);
}

export function normalizeManagerRecords(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("manager records must be an array");
  }

  return records.map((record, index) => {
    if (!isObject(record)) {
      throw new TypeError(`manager record ${index} must be an object`);
    }
    const name = requiredString(record.name, `manager record ${index}.name`);
    const manager = requiredString(
      record.manager ?? record.owner?.manager,
      `manager record ${index}.manager`,
    );
    const source = isObject(record.source)
      ? record.source.kind === "repository"
        ? {
            ...record.source,
            repository: requiredString(
              normalizeRepositoryUrl(record.source.repository),
              `manager record ${index}.source.repository`,
            ),
          }
        : { ...record.source }
      : { kind: "local" };

    return {
      ...record,
      name,
      path:
        record.path === null || record.path === undefined
          ? null
          : requiredString(record.path, `manager record ${index}.path`),
      scope: record.scope === "workspace" || record.scope === "project"
        ? "workspace"
        : "global",
      manager,
      owner: isObject(record.owner)
        ? { ...record.owner, manager }
        : { kind: "manager", manager },
      source,
      evidence: isObject(record.evidence)
        ? { ...record.evidence, manager }
        : { kind: "manager-metadata", manager },
      provenance: isObject(record.provenance)
        ? { ...record.provenance }
        : source.kind === "repository"
          ? { ...source }
          : { kind: "local" },
    };
  });
}

export function parseVercelV3Lock(data, options = {}) {
  const lock = jsonValue(data, "Vercel lock");
  if (!isObject(lock) || lock.version !== 3 || !isObject(lock.skills)) {
    throw new TypeError("Vercel lock must use exactly version 3 with a skills object");
  }

  const lockPath = optionalString(options.lockPath);
  const skillRoot = optionalString(options.skillRoot)
    ?? (lockPath ? path.join(path.dirname(lockPath), "skills") : undefined);
  const scope = options.scope === "workspace" || options.scope === "project"
    ? "workspace"
    : "global";

  const records = Object.entries(lock.skills).map(([rawName, rawEntry]) => {
    const name = requiredString(rawName, "Vercel skill name");
    if (!isObject(rawEntry)) {
      throw new TypeError(`Vercel skill ${name} must be an object`);
    }
    const source = requiredString(rawEntry.source, `${name}.source`);
    const sourceType = requiredString(rawEntry.sourceType, `${name}.sourceType`);
    const sourceUrl = requiredString(rawEntry.sourceUrl, `${name}.sourceUrl`);
    const skillPath = requiredString(rawEntry.skillPath, `${name}.skillPath`);
    const fingerprint = requiredString(
      rawEntry.hash ?? rawEntry.skillFolderHash,
      `${name}.hash`,
    );
    const upstreamPath = directoryPath(skillPath);
    const repository = repositoryFromExplicitSource(
      sourceType,
      sourceUrl,
      source,
    );
    const isLocal = sourceType.toLowerCase() === "local";
    const installedPath = isLocal
      ? (/skill\.md$/i.test(sourceUrl) ? path.dirname(sourceUrl) : sourceUrl)
      : skillRoot
        ? path.join(skillRoot, name)
        : null;
    const normalizedSource = repository
      ? {
          kind: "repository",
          repository,
          ...(upstreamPath ? { upstreamPath } : {}),
        }
      : { kind: "local" };

    return {
      name,
      path: installedPath,
      scope,
      manager: "vercel",
      owner: MANAGER_OWNERS.vercel,
      source: normalizedSource,
      evidence: {
        kind: "manager-metadata",
        manager: "vercel",
        source,
        sourceType,
        sourceUrl,
        skillPath,
      },
      provenance: repository
        ? {
            kind: "repository",
            repository,
            ...(upstreamPath ? { upstreamPath } : {}),
            fingerprint,
          }
        : {
            kind: "local",
            path: sourceUrl,
            fingerprint,
          },
    };
  });

  return normalizeManagerRecords(records);
}

export const normalizeVercelLock = parseVercelV3Lock;

export function parseAsmJson(data) {
  const records = rowsFromEnvelope(data, "ASM JSON").map((rawEntry, index) => {
    if (!isObject(rawEntry)) {
      throw new TypeError(`ASM skill ${index} must be an object`);
    }
    const name = requiredString(
      rawEntry.name ?? rawEntry.dirName,
      `ASM skill ${index}.name`,
    );
    const sourceObject = isObject(rawEntry.source) ? rawEntry.source : {};
    const sourceType = optionalString(
      rawEntry.sourceType
        ?? rawEntry.source_type
        ?? sourceObject.type
        ?? sourceObject.kind,
    );
    const sourceUrl = optionalString(
      rawEntry.sourceUrl
        ?? rawEntry.source_url
        ?? rawEntry.repository
        ?? rawEntry.repositoryUrl
        ?? sourceObject.url
        ?? sourceObject.repository
        ?? (typeof rawEntry.source === "string" ? rawEntry.source : undefined),
    );
    const sourcePath = optionalString(
      rawEntry.skillPath
        ?? rawEntry.skill_path
        ?? rawEntry.sourceSubpath
        ?? sourceObject.skillPath
        ?? sourceObject.upstreamPath,
    );
    const upstreamPath = sourcePath ? directoryPath(sourcePath) : undefined;
    const revision = optionalString(
      rawEntry.commitHash
        ?? rawEntry.commit
        ?? rawEntry.revision
        ?? sourceObject.commitHash
        ?? sourceObject.revision,
    );
    const fingerprint = optionalString(
      rawEntry.contentHash ?? rawEntry.hash ?? sourceObject.fingerprint,
    );
    const repository = sourceType
      ? repositoryFromExplicitSource(sourceType, sourceUrl, sourceUrl)
      : undefined;
    const normalizedSource = repository
      ? {
          kind: "repository",
          repository,
          ...(upstreamPath ? { upstreamPath } : {}),
          ...(revision ? { revision } : {}),
        }
      : { kind: "local" };

    return {
      name,
      path: optionalString(
        rawEntry.path
          ?? rawEntry.originalPath
          ?? rawEntry.realPath
          ?? rawEntry.libraryPath,
      ) ?? null,
      scope:
        rawEntry.scope === "project" || rawEntry.scope === "workspace"
          ? "workspace"
          : "global",
      manager: "asm",
      owner: MANAGER_OWNERS.asm,
      source: normalizedSource,
      evidence: {
        kind: "manager-metadata",
        manager: "asm",
        ...(optionalString(rawEntry.provider)
          ? { provider: rawEntry.provider.trim() }
          : {}),
        ...(optionalString(rawEntry.dirName)
          ? { dirName: rawEntry.dirName.trim() }
          : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
      },
      provenance: repository
        ? {
            kind: "repository",
            repository,
            ...(upstreamPath ? { upstreamPath } : {}),
            ...(revision ? { revision } : {}),
            ...(fingerprint ? { fingerprint } : {}),
          }
        : {
            kind: "local",
            ...(sourceUrl ? { reference: sourceUrl } : {}),
            ...(fingerprint ? { fingerprint } : {}),
          },
    };
  });

  return normalizeManagerRecords(records);
}

export const normalizeAsmList = parseAsmJson;

function normalizeXingRow(rawEntry, index) {
  if (!isObject(rawEntry)) {
    throw new TypeError(`xing skill ${index} must be an object`);
  }
  const name = requiredString(rawEntry.name, `xing skill ${index}.name`);
  const sourceType = requiredString(
    rawEntry.source_type ?? rawEntry.sourceType ?? "local",
    `xing skill ${index}.source_type`,
  );
  const sourceReference = optionalString(
    rawEntry.source_ref_resolved
      ?? rawEntry.sourceRefResolved
      ?? rawEntry.source_ref
      ?? rawEntry.sourceRef,
  );
  const originalReference = optionalString(
    rawEntry.source_ref ?? rawEntry.sourceRef,
  );
  const sourcePath = optionalString(
    rawEntry.source_subpath ?? rawEntry.sourceSubpath,
  );
  const upstreamPath = sourcePath ? directoryPath(sourcePath) : undefined;
  const revision = optionalString(
    rawEntry.source_revision
      ?? rawEntry.sourceRevision
      ?? rawEntry.remote_revision
      ?? rawEntry.remoteRevision,
  );
  const fingerprint = optionalString(
    rawEntry.content_hash ?? rawEntry.contentHash,
  );
  const repository = repositoryFromExplicitSource(
    sourceType,
    sourceReference,
    originalReference,
  );
  const normalizedSource = repository
    ? {
        kind: "repository",
        repository,
        ...(upstreamPath ? { upstreamPath } : {}),
        ...(revision ? { revision } : {}),
      }
    : { kind: "local" };

  return {
    name,
    path: optionalString(rawEntry.central_path ?? rawEntry.path) ?? null,
    scope: "global",
    manager: "xing",
    owner: MANAGER_OWNERS.xing,
    source: normalizedSource,
    evidence: {
      kind: "manager-metadata",
      manager: "xing",
      ...(optionalString(rawEntry.id) ? { id: rawEntry.id.trim() } : {}),
      sourceType,
      ...(originalReference ? { sourceRef: originalReference } : {}),
      ...(sourceReference && sourceReference !== originalReference
        ? { sourceRefResolved: sourceReference }
        : {}),
      ...(optionalString(rawEntry.source_branch ?? rawEntry.sourceBranch)
        ? {
            sourceBranch: (rawEntry.source_branch ?? rawEntry.sourceBranch).trim(),
          }
        : {}),
    },
    provenance: repository
      ? {
          kind: "repository",
          repository,
          ...(upstreamPath ? { upstreamPath } : {}),
          ...(revision ? { revision } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        }
      : {
          kind: "local",
          ...(originalReference ? { reference: originalReference } : {}),
          ...(fingerprint ? { fingerprint } : {}),
        },
    ...(typeof rawEntry.enabled === "boolean"
      ? { enabled: rawEntry.enabled }
      : typeof rawEntry.enabled === "number"
        ? { enabled: rawEntry.enabled !== 0 }
        : {}),
  };
}

export function parseXingJson(data) {
  return normalizeManagerRecords(
    rowsFromEnvelope(data, "xing CLI JSON").map(normalizeXingRow),
  );
}

export const normalizeXingCli = parseXingJson;

const XING_V7_COLUMNS = Object.freeze([
  "name",
  "central_path",
  "source_type",
  "source_ref",
  "source_ref_resolved",
  "source_subpath",
  "source_branch",
  "source_revision",
  "content_hash",
  "enabled",
]);

function sqliteRows(output, label) {
  let value = output;
  if (isObject(value) && Object.hasOwn(value, "stdout")) value = value.stdout;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    if (value.trim() === "") return [];
    value = jsonValue(value, label);
  }
  if (Array.isArray(value)) return value;
  if (isObject(value)) return [value];
  throw new TypeError(`${label} did not return SQLite JSON rows`);
}

async function sqliteQuery(dbPath, sql, run) {
  if (run) return sqliteRows(await run(dbPath, sql), "xing SQLite runner");
  try {
    const result = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return sqliteRows(result, "sqlite3");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "xing SQLite fallback requires sqlite3 on PATH or an injected run function",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function readXingSqlite(dbPath, { run } = {}) {
  const database = requiredString(dbPath, "xing SQLite database path");
  if (run !== undefined && typeof run !== "function") {
    throw new TypeError("readXingSqlite run must be a function");
  }

  const versionRows = await sqliteQuery(
    database,
    "PRAGMA user_version;",
    run,
  );
  const version = Number(
    versionRows[0]?.user_version ?? Object.values(versionRows[0] ?? {})[0],
  );
  if (version !== 7) {
    const rendered = Number.isFinite(version) ? version : "unknown";
    throw new Error(`Unsupported xing SQLite schema version ${rendered}; expected 7`);
  }

  const schemaRows = await sqliteQuery(
    database,
    "PRAGMA table_info(skills);",
    run,
  );
  const availableColumns = new Set(
    schemaRows.map((row) => optionalString(row?.name)).filter(Boolean),
  );
  const missingColumns = XING_V7_COLUMNS.filter(
    (column) => !availableColumns.has(column),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      `xing SQLite v7 skills schema is missing columns: ${missingColumns.join(", ")}`,
    );
  }

  const rows = await sqliteQuery(
    database,
    `SELECT ${XING_V7_COLUMNS.join(", ")} FROM skills ORDER BY name, central_path;`,
    run,
  );
  return normalizeManagerRecords(rows.map(normalizeXingRow));
}

const JTIANLING_LIBRARY_ROOTS = Object.freeze([
  "official",
  "community",
  "custom",
  "registry",
]);

function safeManagerKey(value, label) {
  const key = requiredString(value, label).replaceAll("\\", "/");
  const parts = key.split("/");
  if (
    path.posix.isAbsolute(key)
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`${label} must be a manager-relative path`);
  }
  return parts.join("/");
}

function readInstalledSkillName(skillFile) {
  try {
    return optionalString(
      parseSkillMetadata(readFileSync(skillFile, "utf8")).name,
    );
  } catch {
    return undefined;
  }
}

function collectJtianlingSkillDirectories(root) {
  const found = [];

  function visit(directory, depth, ancestors) {
    if (depth > 16 || !existsSync(directory)) return;
    let canonical;
    try {
      if (!statSync(directory).isDirectory()) return;
      canonical = realpathSync(directory);
    } catch {
      return;
    }
    if (ancestors.has(canonical)) return;
    const nextAncestors = new Set(ancestors).add(canonical);

    if (
      existsSync(path.join(directory, "SKILL.md"))
      || existsSync(path.join(directory, "skill.md"))
    ) {
      found.push(directory);
      return;
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        visit(path.join(directory, entry.name), depth + 1, nextAncestors);
      }
    }
  }

  for (const libraryRoot of JTIANLING_LIBRARY_ROOTS) {
    visit(path.join(root, libraryRoot), 0, new Set());
  }
  return found;
}

function jtianlingBundleIndex(bundles) {
  const byMember = new Map();
  for (const [rawId, rawBundle] of Object.entries(bundles)) {
    const id = requiredString(rawId, "jtianling bundle id");
    if (!isObject(rawBundle)) {
      throw new TypeError(`jtianling bundle ${id} must be an object`);
    }
    const type = requiredString(rawBundle.type, `${id}.type`).toLowerCase();
    if (!new Set(["git", "registry", "zip", "local-batch"]).has(type)) {
      throw new TypeError(`Unsupported jtianling bundle type ${type}`);
    }
    const url = optionalString(rawBundle.url);
    if (!Array.isArray(rawBundle.members)) {
      throw new TypeError(`${id}.members must be an array`);
    }
    const bundle = { id, type, url, raw: rawBundle };
    for (const rawMember of rawBundle.members) {
      const member = safeManagerKey(rawMember, `${id}.members entry`);
      const existing = byMember.get(member);
      const identity = `${type}\0${url ?? ""}`;
      if (
        existing
        && `${existing.type}\0${existing.url ?? ""}` !== identity
      ) {
        throw new Error(
          `Conflicting jtianling bundle provenance for ${member}: ${existing.id} and ${id}`,
        );
      }
      byMember.set(member, bundle);
    }
  }
  return byMember;
}

function jtianlingIdentity(sourceKey, sourceInfo, bundle) {
  const installMethod = optionalString(sourceInfo.installMethod)?.toLowerCase()
    ?? bundle?.type
    ?? (sourceInfo.type === "official" || sourceInfo.type === "community"
      ? "git"
      : "local-copy");
  const reference = optionalString(sourceInfo.url) ?? bundle?.url;
  const repository = installMethod === "git"
    ? repositoryFromExplicitSource("git", reference, reference)
    : undefined;

  if (repository) {
    return {
      source: { kind: "repository", repository },
      provenance: {
        kind: "repository",
        repository,
        sourceKey,
        ...(bundle ? { bundleType: bundle.type, bundleId: bundle.id } : {}),
      },
      installMethod,
    };
  }

  if (installMethod === "registry") {
    return {
      source: { kind: "local" },
      provenance: {
        kind: "registry",
        sourceKey,
        reference: optionalString(sourceInfo.registryUrl) ?? reference ?? sourceKey,
        ...(optionalString(sourceInfo.version)
          ? { version: sourceInfo.version.trim() }
          : {}),
        ...(bundle ? { bundleType: bundle.type, bundleId: bundle.id } : {}),
      },
      installMethod,
    };
  }

  if (installMethod === "zip") {
    return {
      source: { kind: "local" },
      provenance: {
        kind: "archive",
        sourceKey,
        ...(reference ? { reference } : {}),
        ...(bundle ? { bundleType: bundle.type, bundleId: bundle.id } : {}),
      },
      installMethod,
    };
  }

  return {
    source: { kind: "local" },
    provenance: {
      kind: "local",
      sourceKey,
      ...(reference ? { reference } : {}),
      ...(bundle ? { bundleType: bundle.type, bundleId: bundle.id } : {}),
    },
    installMethod,
  };
}

function jtianlingRecord({ name, installedPath, sourceKey, sourceInfo, bundle }) {
  const identity = jtianlingIdentity(sourceKey, sourceInfo, bundle);
  return {
    name,
    path: installedPath,
    scope: "global",
    manager: "jtianling",
    owner: MANAGER_OWNERS.jtianling,
    source: identity.source,
    evidence: {
      kind: installedPath ? "manager-library" : "manager-metadata",
      manager: "jtianling",
      sourceKey,
      installMethod: identity.installMethod,
      ...(bundle ? { bundleId: bundle.id } : {}),
    },
    provenance: identity.provenance,
  };
}

export function parseJtianlingSources(data, { root } = {}) {
  const parsed = jsonValue(data, "jtianling sources.json");
  if (!isObject(parsed)) {
    throw new TypeError("jtianling sources.json must be an object");
  }
  const version = parsed.version;
  if (
    version !== undefined
    && !new Set([1, 2, 3, "1.0", "2.0", "3.0"]).has(version)
  ) {
    throw new TypeError(`Unsupported jtianling sources.json version ${version}`);
  }
  if (parsed.sources !== undefined && !isObject(parsed.sources)) {
    throw new TypeError("jtianling sources.json sources must be an object");
  }
  if (parsed.bundles !== undefined && !isObject(parsed.bundles)) {
    throw new TypeError("jtianling sources.json bundles must be an object");
  }

  const sources = new Map();
  for (const [rawKey, rawInfo] of Object.entries(parsed.sources ?? {})) {
    const sourceKey = safeManagerKey(rawKey, "jtianling source key");
    if (!isObject(rawInfo)) {
      throw new TypeError(`jtianling source ${sourceKey} must be an object`);
    }
    sources.set(sourceKey, rawInfo);
  }
  const bundleByMember = jtianlingBundleIndex(parsed.bundles ?? {});
  for (const [member, bundle] of bundleByMember) {
    if (!sources.has(member)) {
      sources.set(member, {
        type: bundle.type === "registry" ? "registry" : "custom",
        repoName: path.posix.basename(member),
        installMethod: bundle.type === "local-batch" ? "local-copy" : bundle.type,
        ...(bundle.url ? { url: bundle.url } : {}),
      });
    }
  }

  const managerRoot = root === undefined
    ? undefined
    : path.resolve(requiredString(root, "jtianling manager root"));
  const usedSources = new Set();
  const records = [];

  if (managerRoot) {
    for (const installedPath of collectJtianlingSkillDirectories(managerRoot)) {
      const relative = path.relative(managerRoot, installedPath).split(path.sep).join("/");
      const sourceKey = [...sources.keys()]
        .filter((key) => relative === key || relative.startsWith(`${key}/`))
        .sort((left, right) => right.length - left.length)[0];
      const skillFile = existsSync(path.join(installedPath, "SKILL.md"))
        ? path.join(installedPath, "SKILL.md")
        : path.join(installedPath, "skill.md");
      const name = readInstalledSkillName(skillFile) ?? path.basename(installedPath);

      if (sourceKey) {
        usedSources.add(sourceKey);
        records.push(
          jtianlingRecord({
            name,
            installedPath,
            sourceKey,
            sourceInfo: sources.get(sourceKey),
            bundle: bundleByMember.get(sourceKey)
              ?? bundleByMember.get(relative),
          }),
        );
      } else {
        records.push({
          name,
          path: installedPath,
          scope: "global",
          manager: "jtianling",
          owner: MANAGER_OWNERS.jtianling,
          source: { kind: "local" },
          evidence: {
            kind: "manager-library",
            manager: "jtianling",
            libraryPath: relative,
          },
          provenance: { kind: "local", path: installedPath },
        });
      }
    }
  }

  for (const [sourceKey, sourceInfo] of sources) {
    if (usedSources.has(sourceKey)) continue;
    records.push(
      jtianlingRecord({
        name: optionalString(sourceInfo.repoName) ?? path.posix.basename(sourceKey),
        installedPath: null,
        sourceKey,
        sourceInfo,
        bundle: bundleByMember.get(sourceKey),
      }),
    );
  }

  return normalizeManagerRecords(records);
}

export const normalizeJtianlingSources = parseJtianlingSources;
