import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const updateQueues = new Map();
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 10;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function acquireStateLock(
  filePath,
  {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    retryMs = DEFAULT_RETRY_MS,
  } = {},
) {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurable(directory);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    const token = randomUUID();
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            token,
            pid: process.pid,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        const current = await readLockOwner(lockPath);
        if (current?.token === token) {
          await unlink(lockPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
        } catch (ownerError) {
          if (ownerError.code === "ESRCH") {
            const abandoned = new Error(
              `state lock owner exited; verify and remove abandoned lock ${lockPath}`,
            );
            abandoned.code = "STATE_LOCK_ABANDONED";
            abandoned.details = { lockPath, owner };
            throw abandoned;
          }
        }
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(`timed out waiting for state lock ${lockPath}`);
        timeout.code = "STATE_LOCK_TIMEOUT";
        throw timeout;
      }
      await delay(retryMs + Math.floor(Math.random() * retryMs));
    }
  }
}

export async function readJsonState(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value, options) {
  return writeFileAtomic(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    options,
  );
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurable(directory) {
  const created = await mkdir(directory, { recursive: true });
  if (!created) return;
  const stableAncestor = path.dirname(path.resolve(created));
  let current = path.resolve(directory);
  while (true) {
    await syncDirectory(current);
    if (current === stableAncestor) return;
    current = path.dirname(current);
  }
}

export async function writeFileAtomic(filePath, contents, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  await ensureDirectoryDurable(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function updateJsonAtomic(filePath, fallback, update) {
  const key = path.resolve(filePath);
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const release = await acquireStateLock(filePath);
      try {
        const current = await readJsonState(filePath, fallback);
        const next = await update(current);
        await writeJsonAtomic(filePath, next);
        return next;
      } finally {
        await release();
      }
    });
  updateQueues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (updateQueues.get(key) === operation) updateQueues.delete(key);
  }
}
