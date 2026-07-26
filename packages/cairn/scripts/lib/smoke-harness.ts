/**
 * Minimal shared helpers for Cairn smoke scripts.
 * assert / mkRepo / cleanup — extracted from the duplicated per-smoke boilerplate.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: string[] = [];

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

export function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export interface MkRepoOpts {
  /** When true, mkdir `.cairn` under the temp root. */
  cairn?: boolean;
}

/** Ephemeral temp dir tracked for cleanup on exit or assert failure. */
export function mkRepo(prefix = "cairn-smoke-", opts: MkRepoOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  if (opts.cairn) {
    mkdirSync(join(dir, ".cairn"), { recursive: true });
  }
  return dir;
}
