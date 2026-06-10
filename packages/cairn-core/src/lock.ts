/**
 * Per-write filesystem lock for `.cairn/` global state.
 *
 * Per docs/PLUGIN_ARCHITECTURE.md §7 (Concurrency): every write to global
 * state (`.cairn/ground/`, `.cairn/baseline/`, `.cairn/inbox/`) is
 * serialized through `.cairn/.write-lock` so concurrent Claude Code
 * sessions don't race. Reads are unlocked. Whole-operation locks
 * (`.gc-lock`, `.audit-lock`) are separate — see acquireOperationLock.
 *
 * Design:
 *   - `wx` (O_CREAT | O_EXCL) atomic-create on the lock file. PID written
 *     inside so stale-holder detection can recover from crashes.
 *   - Stale-lock recovery: if the holder PID is gone, claim the lock.
 *   - Polling backoff with deadline. Brief contention; long waits indicate
 *     deadlock and surface as timeout errors.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

export interface WithLockOptions {
  /** Hard deadline. Default 30000ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 50ms. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 50;

/**
 * Acquire `.cairn/.write-lock` for the lifetime of `fn`. Releases on
 * success or error. Stale locks (holder PID is dead) are reclaimed.
 */
export async function withWriteLock<T>(
  repoRoot: string,
  fn: () => Promise<T> | T,
  opts: WithLockOptions = {},
): Promise<T> {
  return withLockAtPath(cairnDir(repoRoot, ".write-lock"), fn, opts);
}

/**
 * Acquire a named operation lock (e.g. `.gc-lock`, `.audit-lock`) for the
 * lifetime of `fn`. If the lock is held, this throws immediately rather
 * than waiting — callers (sweep, audit) use this to bail with "another
 * operation in progress".
 */
export async function acquireOperationLock<T>(
  repoRoot: string,
  lockName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockPath = cairnDir(repoRoot, lockName);
  await mkdir(dirname(lockPath), { recursive: true });
  const acquired = await tryAcquire(lockPath);
  if (!acquired) {
    throw new OperationLockHeldError(lockName, await readHolderPid(lockPath));
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

export class OperationLockHeldError extends Error {
  constructor(
    public readonly lockName: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `operation lock ${lockName} is held${holderPid !== null ? ` by pid ${holderPid}` : ""}`,
    );
    this.name = "OperationLockHeldError";
  }
}

async function withLockAtPath<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: WithLockOptions,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  // Spin until acquired or deadline.
  while (true) {
    if (await tryAcquire(lockPath)) break;
    if (await reclaimIfStale(lockPath)) {
      if (await tryAcquire(lockPath)) break;
    }
    if (Date.now() >= deadline) {
      const holder = await readHolderPid(lockPath);
      throw new Error(
        `write lock timeout after ${timeoutMs}ms${holder !== null ? ` (held by pid ${holder})` : ""}`,
      );
    }
    await sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const fd = await open(lockPath, "wx");
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function readHolderPid(lockPath: string): Promise<number | null> {
  try {
    const body = await readFile(lockPath, "utf8");
    const n = Number.parseInt(body.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function reclaimIfStale(lockPath: string): Promise<boolean> {
  const pid = await readHolderPid(lockPath);
  if (pid === null) return false;
  if (isProcessAlive(pid)) return false;
  await unlink(lockPath).catch(() => {});
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 throws if the process doesn't exist.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
