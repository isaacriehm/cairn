#!/usr/bin/env tsx
/**
 * smoke-lock — verifies cairn-core/src/lock.ts.
 *
 * Two scenarios:
 *   1) Concurrent withWriteLock calls serialize and produce a stable
 *      ordering of writes (no torn writes, no skipped acquisitions).
 *   2) acquireOperationLock throws OperationLockHeldError when the lock
 *      is already held — used by sweep + audit to bail fast.
 */

import {
  acquireOperationLock,
  OperationLockHeldError,
  withWriteLock,
} from "@isaacriehm/cairn-core";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fail(reason: string): never {
  console.error(`smoke-lock FAIL: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-lock-"));
  try {
    console.log("── Step 1: serialized concurrent writes");
    const out = join(root, "log.txt");
    writeFileSync(out, "");
    const N = 8;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        withWriteLock(root, async () => {
          // Read-modify-write — race-prone without the lock.
          const cur = readFileSync(out, "utf8");
          await new Promise((r) => setTimeout(r, 5));
          writeFileSync(out, `${cur}${i}\n`);
        }),
      );
    }
    await Promise.all(tasks);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    if (lines.length !== N) fail(`expected ${N} lines, got ${lines.length}: ${lines.join(",")}`);
    const set = new Set(lines);
    if (set.size !== N) fail(`expected ${N} unique entries, got ${set.size}`);
    if (existsSync(join(root, ".harness", ".write-lock"))) {
      fail("lock file should be released after use");
    }

    console.log("── Step 2: acquireOperationLock — held throws");
    let inner: Promise<void> | null = null;
    let release: (() => void) | null = null;
    const outer = acquireOperationLock(root, ".gc-lock", async () => {
      inner = (async () => {
        try {
          await acquireOperationLock(root, ".gc-lock", async () => {
            fail("inner acquireOperationLock should not have run");
          });
        } catch (err) {
          if (!(err instanceof OperationLockHeldError)) fail(`expected OperationLockHeldError, got ${err}`);
          if (err.lockName !== ".gc-lock") fail(`unexpected lockName: ${err.lockName}`);
        }
      })();
      await new Promise<void>((r) => {
        release = r;
        setTimeout(r, 30);
      });
    });
    void release;
    await outer;
    if (inner !== null) await inner;
    if (existsSync(join(root, ".harness", ".gc-lock"))) {
      fail("operation lock should be released after use");
    }

    console.log("\nsmoke-lock: OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
