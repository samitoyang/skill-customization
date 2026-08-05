import { createHash } from "node:crypto";
import path from "node:path";

function looksLikeRepository(value) {
  return (
    /^(?:https?|ssh|git|git\+https):\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:[^\s]+$/.test(value) ||
    /^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)
  );
}

function toUrl(value) {
  const trimmed = value.trim();
  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return new URL(`https://${scp[1]}/${scp[2]}`);
  if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(trimmed)) {
    return new URL(`https://github.com/${trimmed}`);
  }
  const rewritten = trimmed
    .replace(/^git\+https:/i, "https:")
    .replace(/^ssh:\/\/git@/i, "https://")
    .replace(/^git:\/\//i, "https://");
  return new URL(rewritten);
}

export function normalizeRepositoryUrl(value) {
  if (typeof value !== "string" || !looksLikeRepository(value)) {
    throw new TypeError("repository must be a URL, SSH locator, or owner/repository slug");
  }
  let url;
  try {
    url = toUrl(value);
  } catch (error) {
    throw new TypeError(`invalid repository locator: ${error.message}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`unsupported repository protocol ${url.protocol}`);
  }
  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!pathname || pathname === "/") throw new TypeError("repository path is missing");
  url.pathname = pathname;
  return `${url.origin}${url.pathname}`;
}

export function normalizeRepositoryLocator(value) {
  const url = toUrl(value);
  const segments = url.pathname.split("/").filter(Boolean);
  let marker = -1;
  let markerLength = 1;
  if (url.hostname.toLowerCase() === "github.com") {
    marker = segments.indexOf("tree", 2);
  } else {
    marker = segments.findIndex(
      (segment, index) => segment === "tree" && segments[index - 1] === "-",
    );
    markerLength = marker >= 0 ? 1 : markerLength;
  }
  if (marker < 0) {
    return { repository: normalizeRepositoryUrl(value) };
  }
  const repositorySegments = segments.slice(0, marker);
  if (repositorySegments.at(-1) === "-") repositorySegments.pop();
  const revision = segments[marker + markerLength];
  const subdir = segments.slice(marker + markerLength + 1).join("/") || undefined;
  return {
    repository: normalizeRepositoryUrl(
      `${url.protocol}//${url.host}/${repositorySegments.join("/")}`,
    ),
    revision: decodeURIComponent(revision),
    ...(subdir ? { subdir: decodeURIComponent(subdir) } : {}),
  };
}

export function normalizeUpstreamEntrypoint(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  normalized = path.posix.normalize(normalized).replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") return "SKILL.md";
  if (/skill\.md$/i.test(normalized)) {
    return `${normalized.slice(0, -"SKILL.md".length)}SKILL.md`;
  }
  return `${normalized}/SKILL.md`;
}

export function generateLocalIdentity({ skillName, fingerprint }) {
  if (typeof skillName !== "string" || typeof fingerprint !== "string") {
    throw new TypeError("skillName and fingerprint are required");
  }
  const digest = createHash("sha256")
    .update(skillName)
    .update("\0")
    .update(fingerprint)
    .digest("hex");
  return `local:sha256:${digest}`;
}

export function isRepositoryLocator(value) {
  return typeof value === "string" && looksLikeRepository(value);
}
