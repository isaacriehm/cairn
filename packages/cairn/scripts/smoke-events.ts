#!/usr/bin/env tsx
/**
 * smoke-events — invalidation events writer + reader + GC.
 *
 * Spec: PLUGIN_ARCHITECTURE §7. Verifies:
 *   1. writeInvalidationEvent emits a JSON file under `.cairn/events/`
 *      with the expected payload + name shape.
 *   2. eventsSince filters by ts and sorts ascending; ignores malformed
 *      files without throwing.
 *   3. gcStaleEvents removes events older than maxAgeMs and keeps fresh.
 *   4. seedEventsMarker is idempotent and stampEventsPoll updates the
 *      poll cursor without resetting `ts`.
 *   5. End-to-end: cairn_record_decision writes a draft AND emits a
 *      `decision_drafted` event referencing the new DEC id.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  eventsDir,
  eventsSince,
  gcStaleEvents,
  readEventsMarker,
  seedEventsMarker,
  stampEventsPoll,
  writeInvalidationEvent,
  type InvalidationEvent,
  type McpContext,
  type ToolDef,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-events-"));
  cleanups.push(dir);
  return dir;
}

function listEventFiles(repoRoot: string): string[] {
  const dir = eventsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { encoding: "utf8" }).filter((name) => name.endsWith(".json"));
}

async function runSmoke(): Promise<void> {
  console.log("smoke-events — start");

  // ── Step 1 — writer round-trip ────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const t0 = 1_700_000_000_000;
    const result = writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-deadbee" }],
      path: ".cairn/ground/decisions/_inbox/DEC-deadbee.draft.md",
      source: { session_id: "session-x", tool: "cairn_record_decision" },
      ts: t0,
    });
    assert(existsSync(result.filePath), "Step 1: file should exist");
    assert(result.filePath.includes("decision_drafted"), `Step 1: filename must include kind, got ${result.filePath}`);
    const parsed = JSON.parse(readFileSync(result.filePath, "utf8")) as InvalidationEvent;
    assert(parsed.ts === t0, "Step 1: ts mismatch");
    assert(parsed.kind === "decision_drafted", "Step 1: kind mismatch");
    assert(parsed.refs.length === 1 && parsed.refs[0]?.id === "DEC-deadbee", "Step 1: ref mismatch");
    console.log("  ✓ Step 1 — writer round-trip");
  }

  // ── Step 2 — collision suffix when ts repeats ────────────────────
  {
    const repoRoot = mkRepoRoot();
    const ts = 1_700_000_000_001;
    const a = writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-a3f7b2c" }],
      source: { session_id: null, tool: "cairn_record_decision" },
      ts,
    });
    const b = writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-5e9d10a" }],
      source: { session_id: null, tool: "cairn_record_decision" },
      ts,
    });
    assert(a.filePath !== b.filePath, "Step 2: collision should produce distinct files");
    console.log("  ✓ Step 2 — collision suffix");
  }

  // ── Step 3 — eventsSince filters + sorts ─────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-a3f7b2c" }],
      source: { session_id: null, tool: "test" },
      ts: 1_000,
    });
    writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-5e9d10a" }],
      source: { session_id: null, tool: "test" },
      ts: 2_000,
    });
    writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-1234567" }],
      source: { session_id: null, tool: "test" },
      ts: 3_000,
    });
    // toss in a malformed file
    const bogus = join(eventsDir(repoRoot), "00000000001500-bogus.json");
    writeFileSync(bogus, "not json");

    const after1500 = eventsSince({ repoRoot, sinceMs: 1_500 });
    assert(after1500.events.length === 2, `Step 3: expected 2 events, got ${after1500.events.length}`);
    assert(after1500.events[0]?.ts === 2_000, "Step 3: should sort ascending");
    assert(after1500.events[1]?.ts === 3_000, "Step 3: should sort ascending");
    assert(after1500.malformed.includes("00000000001500-bogus.json"), "Step 3: malformed should be reported");
    const limited = eventsSince({ repoRoot, sinceMs: 0, limit: 2 });
    assert(limited.events.length === 2 && limited.events[0]?.ts === 1_000, "Step 3: limit caps tail");
    console.log("  ✓ Step 3 — eventsSince filter + sort");
  }

  // ── Step 4 — gcStaleEvents removes old, keeps fresh ──────────────
  {
    const repoRoot = mkRepoRoot();
    const now = 10_000_000_000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-OLD" }],
      source: { session_id: null, tool: "test" },
      ts: now - sevenDays - 1,
    });
    writeInvalidationEvent(repoRoot, {
      kind: "decision_drafted",
      refs: [{ kind: "decision", id: "DEC-NEW" }],
      source: { session_id: null, tool: "test" },
      ts: now - 1_000,
    });
    const result = gcStaleEvents({ repoRoot, now: () => now });
    assert(result.removed.length === 1, `Step 4: expected 1 removed, got ${result.removed.length}`);
    assert(result.kept.length === 1, `Step 4: expected 1 kept, got ${result.kept.length}`);
    console.log("  ✓ Step 4 — gcStaleEvents 7-day boundary");
  }

  // ── Step 5 — events marker seed + stamp ──────────────────────────
  {
    const repoRoot = mkRepoRoot();
    // ensure session dir exists so the marker has a home
    mkdirSync(join(repoRoot, ".cairn", "sessions", "abc"), { recursive: true });
    const seeded = seedEventsMarker({ repoRoot, sessionId: "abc", ts: 5_000 });
    assert(seeded.ts === 5_000 && seeded.last_polled_ts === 5_000, "Step 5: seed should set both ts");

    // re-seed should be idempotent — does not move ts
    const seedAgain = seedEventsMarker({ repoRoot, sessionId: "abc", ts: 9_999 });
    assert(seedAgain.ts === 5_000, "Step 5: re-seed should keep original ts");

    const stamped = stampEventsPoll({ repoRoot, sessionId: "abc", ts: 7_500 });
    assert(stamped.ts === 5_000, "Step 5: stamp should keep ts");
    assert(stamped.last_polled_ts === 7_500, "Step 5: stamp should advance last_polled_ts");
    const reread = readEventsMarker(repoRoot, "abc");
    assert(reread !== null && reread.last_polled_ts === 7_500, "Step 5: marker should persist on disk");
    console.log("  ✓ Step 5 — marker seed + stamp idempotency");
  }

  // ── Step 6 — end-to-end: record_decision tool emits event ───────
  {
    const repoRoot = mkRepoRoot();
    const recordDecisionTool = (allTools as ToolDef<unknown>[]).find(
      (t) => t.name === "cairn_record_decision",
    );
    assert(recordDecisionTool !== undefined, "Step 6: cairn_record_decision should be registered");
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    const before = listEventFiles(repoRoot).length;
    const ctx: McpContext = { repoRoot, sessionId: "session-end-to-end" };
    const out = (await recordDecisionTool.handler(ctx, {
      title: "Ban env vars",
      summary: "Operator hates env vars; hardcode in code.",
      scope_globs: ["**/*.ts"],
      target: "inbox",
    })) as { ok: boolean; id: string };
    assert(out.ok && /^DEC-[0-9a-f]{7,}/.test(out.id), `Step 6: record_decision should return ok+id, got ${JSON.stringify(out)}`);
    const after = listEventFiles(repoRoot);
    assert(after.length === before + 1, `Step 6: should write one event file, got ${after.length}`);
    const eventBody = JSON.parse(readFileSync(join(eventsDir(repoRoot), after[after.length - 1]!), "utf8")) as InvalidationEvent;
    assert(eventBody.kind === "decision_drafted", `Step 6: kind should be decision_drafted, got ${eventBody.kind}`);
    assert(eventBody.refs.some((r) => r.id === out.id), "Step 6: event must ref the new DEC id");
    assert(eventBody.source.session_id === "session-end-to-end", "Step 6: session id should pass through context");
    console.log("  ✓ Step 6 — end-to-end via record_decision");
  }

  console.log("smoke-events — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
