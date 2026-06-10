#!/usr/bin/env tsx
/**
 * smoke-update-check — the SessionStart "newer Cairn available" notice.
 *
 * HOME-isolated: the throttle/last-known cache lives at the machine-global
 * `~/.cairn/update-check.json`, so we point HOME at a throwaway dir and never
 * touch the operator's real `~/.cairn`. No network: every case seeds a FRESH
 * cache (`checkedMs = now`) so `runUpdateCheck` reads the cache and never hits
 * the registry.
 *
 * No LLM burn.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME BEFORE importing — `os.homedir()` resolves it at call time, but
// set both POSIX + Windows vars up front to be safe.
const HOME = mkdtempSync(join(tmpdir(), "cairn-smoke-update-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { isNewer, runUpdateCheck } = await import("@isaacriehm/cairn-core");

const cachePath = join(HOME, ".cairn", "update-check.json");

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    rmSync(HOME, { recursive: true, force: true });
    process.exit(1);
  }
}

function seedCache(latest: string | null, now: number): void {
  mkdirSync(join(HOME, ".cairn"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ checkedMs: now, latest }), "utf8");
}

async function run(): Promise<void> {
  console.log("smoke-update-check — start");
  const now = 1_700_000_000_000;

  // ── 1. isNewer semantics ──────────────────────────────────────────
  assert(isNewer("0.22.0", "0.21.0"), "1: 0.22.0 > 0.21.0");
  assert(isNewer("0.21.1", "0.21.0"), "1: patch bump is newer");
  assert(!isNewer("0.21.0", "0.21.0"), "1: equal is not newer");
  assert(!isNewer("0.20.9", "0.21.0"), "1: older is not newer");
  assert(!isNewer("garbage", "0.21.0"), "1: unparseable fails closed");
  console.log("  ✓ 1 — isNewer semantics");

  // ── 2. newer cached version → banner (no network: fresh cache) ────
  {
    seedCache("9.9.9", now);
    const banner = await runUpdateCheck("0.21.0", now);
    assert(banner !== null, "2: banner expected when cache newer");
    assert(banner!.includes("9.9.9"), `2: banner names latest, got ${banner}`);
    assert(banner!.includes("0.21.0"), "2: banner names current");
    console.log("  ✓ 2 — newer cached version surfaces a banner");
  }

  // ── 3. up to date → null ──────────────────────────────────────────
  {
    seedCache("0.21.0", now);
    const banner = await runUpdateCheck("0.21.0", now);
    assert(banner === null, `3: no banner when current, got ${banner}`);
    console.log("  ✓ 3 — up-to-date is silent");
  }

  // ── 4. unknown latest (null cache, fresh) → null, no throw ────────
  {
    seedCache(null, now);
    const banner = await runUpdateCheck("0.21.0", now);
    assert(banner === null, "4: null latest yields no banner");
    console.log("  ✓ 4 — unknown latest is silent");
  }

  console.log("smoke-update-check — pass");
}

try {
  await run();
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
