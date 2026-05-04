#!/usr/bin/env tsx
/**
 * smoke-session-state — per-session state partition lifecycle.
 *
 * Spec: PLUGIN_ARCHITECTURE §7. Verifies:
 *   1. ensureSessionDir creates `.harness/sessions/<id>/` + meta.json with
 *      session_id / started_at / pid.
 *   2. Two sessions in the same repo write to isolated dirs.
 *   3. cleanupSession removes only its own dir.
 *   4. gcStaleSessions:
 *        a. removes a stale dir whose pid is dead AND whose started_at is
 *           past the maxAgeMs threshold,
 *        b. keeps a fresh dir even with a dead pid,
 *        c. keeps any dir whose pid is alive (use process.pid).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSession,
  ensureSessionDir,
  gcStaleSessions,
  resolveSessionId,
  sessionStateDir,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-session-"));
  cleanups.push(dir);
  return dir;
}

function findUnusedPid(): number {
  // Pick a high-number PID very unlikely to be live. Linux/macOS don't
  // recycle PIDs aggressively at this range during a test run.
  for (let candidate = 999_998; candidate > 100_000; candidate--) {
    try {
      process.kill(candidate, 0);
      // alive — try again
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find an unused PID");
}

function runSmoke(): void {
  console.log("smoke-session-state — start");

  // ── Step 1 — resolveSessionId: payload wins, fallback uuid ────────
  {
    const fromPayload = resolveSessionId({ session_id: "claude-uuid-abc" });
    assert(fromPayload === "claude-uuid-abc", `Step 1: payload id should pass through, got ${fromPayload}`);
    const fallback = resolveSessionId(null);
    assert(typeof fallback === "string" && fallback.length > 0, `Step 1: fallback should be non-empty string`);
    assert(fallback !== fromPayload, "Step 1: fallback should differ from payload id");
    console.log("  ✓ Step 1 — session id resolution");
  }

  // ── Step 2 — ensureSessionDir creates dir + meta.json ────────────
  {
    const repoRoot = mkRepoRoot();
    const result = ensureSessionDir({ repoRoot, sessionId: "session-a" });
    assert(result.created, "Step 2: dir should report created=true");
    const dir = sessionStateDir(repoRoot, "session-a");
    assert(existsSync(dir), `Step 2: dir ${dir} missing`);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    assert(meta["session_id"] === "session-a", "Step 2: meta.session_id mismatch");
    assert(typeof meta["started_at"] === "string", "Step 2: meta.started_at missing");
    assert(meta["pid"] === process.pid, "Step 2: meta.pid should default to process.pid");
    // Re-ensure: should keep started_at + pid
    const again = ensureSessionDir({ repoRoot, sessionId: "session-a" });
    assert(!again.created, "Step 2: second ensure should report created=false");
    assert(again.meta.started_at === meta["started_at"], "Step 2: started_at should not regenerate");
    console.log("  ✓ Step 2 — ensureSessionDir creates + preserves meta");
  }

  // ── Step 3 — two sessions don't collide ──────────────────────────
  {
    const repoRoot = mkRepoRoot();
    ensureSessionDir({ repoRoot, sessionId: "alpha" });
    ensureSessionDir({ repoRoot, sessionId: "beta" });
    assert(existsSync(sessionStateDir(repoRoot, "alpha")), "Step 3: alpha dir missing");
    assert(existsSync(sessionStateDir(repoRoot, "beta")), "Step 3: beta dir missing");
    cleanupSession(repoRoot, "alpha");
    assert(!existsSync(sessionStateDir(repoRoot, "alpha")), "Step 3: alpha should be cleaned up");
    assert(existsSync(sessionStateDir(repoRoot, "beta")), "Step 3: beta should remain");
    console.log("  ✓ Step 3 — concurrent session isolation + cleanup");
  }

  // ── Step 4 — gcStaleSessions removes stale, keeps fresh + live ───
  {
    const repoRoot = mkRepoRoot();
    const deadPid = findUnusedPid();

    // (a) stale: dead pid + started_at past threshold
    const staleId = "stale-session";
    ensureSessionDir({ repoRoot, sessionId: staleId, pid: deadPid });
    // overwrite meta with an old timestamp
    const stalePath = join(sessionStateDir(repoRoot, staleId), "meta.json");
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    rmSync(stalePath, { force: true });
    writeFileSync(
      stalePath,
      JSON.stringify({ session_id: staleId, started_at: longAgo, pid: deadPid }, null, 2),
    );

    // (b) fresh-but-dead: dead pid, recent timestamp → keep
    const freshDeadId = "fresh-dead";
    ensureSessionDir({ repoRoot, sessionId: freshDeadId, pid: deadPid });

    // (c) live: own pid, any timestamp → keep
    const liveId = "live-session";
    ensureSessionDir({ repoRoot, sessionId: liveId, pid: process.pid });

    const result = gcStaleSessions({ repoRoot, maxAgeMs: 24 * 60 * 60 * 1000 });
    assert(result.removed.includes(staleId), `Step 4: stale dir should be removed, got removed=${result.removed.join(",")}`);
    assert(!result.removed.includes(freshDeadId), "Step 4: fresh-but-dead dir should NOT be removed");
    assert(!result.removed.includes(liveId), "Step 4: live-pid dir should NOT be removed");
    assert(!existsSync(sessionStateDir(repoRoot, staleId)), "Step 4: stale dir not actually removed");
    assert(existsSync(sessionStateDir(repoRoot, freshDeadId)), "Step 4: fresh-dead dir gone unexpectedly");
    assert(existsSync(sessionStateDir(repoRoot, liveId)), "Step 4: live dir gone unexpectedly");
    console.log("  ✓ Step 4 — gcStaleSessions selective removal");
  }

  // ── Step 5 — gcStaleSessions on empty/missing root is a no-op ────
  {
    const repoRoot = mkRepoRoot();
    const result = gcStaleSessions({ repoRoot });
    assert(result.removed.length === 0, "Step 5: nothing to remove when root absent");
    assert(result.kept.length === 0, "Step 5: nothing kept when root absent");
    console.log("  ✓ Step 5 — gc no-op on empty root");
  }

  console.log("smoke-session-state — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
