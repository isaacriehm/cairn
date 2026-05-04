#!/usr/bin/env tsx
/**
 * smoke-resolve-attention — verifies harness_resolve_attention covers
 * every kind × choice pathway documented in the tool.
 *
 * Spec: PLUGIN_ARCHITECTURE §9 (plugin-era write tool).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  eventsDir,
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
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-resolve-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".harness", "ground", "decisions", "_inbox"), { recursive: true });
  return dir;
}

function writeDraftDec(repoRoot: string, id: string): string {
  const path = join(repoRoot, ".harness", "ground", "decisions", "_inbox", `${id}.draft.md`);
  const body = `---\nid: ${id}\ntitle: smoke-test draft\nstatus: draft\n---\n\n# ${id} — smoke-test draft\n\nbody.\n`;
  writeFileSync(path, body, "utf8");
  return path;
}

function getResolveTool(): ToolDef<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find((t) => t.name === "harness_resolve_attention");
  assert(tool !== undefined, "harness_resolve_attention should be registered in allTools");
  return tool;
}

async function call(tool: ToolDef<unknown>, ctx: McpContext, input: unknown): Promise<{ ok?: boolean; resolved_kind?: string; [k: string]: unknown }> {
  return (await tool.handler(ctx, input)) as { ok?: boolean; resolved_kind?: string; [k: string]: unknown };
}

function listEventFiles(repoRoot: string): string[] {
  const dir = eventsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { encoding: "utf8" }).filter((n) => n.endsWith(".json"));
}

async function runSmoke(): Promise<void> {
  console.log("smoke-resolve-attention — start");
  const tool = getResolveTool();

  // ── Step 1 — DEC accept (a) → moves draft to canonical, emits event ──
  {
    const repoRoot = mkRepoRoot();
    const draftPath = writeDraftDec(repoRoot, "DEC-1001");
    const ctx: McpContext = { repoRoot, sessionId: "session-a" };
    const result = await call(tool, ctx, {
      item_id: "DEC-1001",
      kind: "decision_draft",
      choice: "a",
    });
    assert(result.ok === true, `Step 1: ok=true expected, got ${JSON.stringify(result)}`);
    assert(result.resolved_kind === "decision_accepted", "Step 1: resolved_kind mismatch");
    const acceptedPath = join(repoRoot, ".harness", "ground", "decisions", "DEC-1001.md");
    assert(existsSync(acceptedPath), "Step 1: canonical DEC file should exist");
    const acceptedBody = readFileSync(acceptedPath, "utf8");
    assert(/status: accepted/.test(acceptedBody), "Step 1: status should be promoted to accepted");
    assert(!existsSync(draftPath), "Step 1: draft should no longer be in _inbox");
    const evs = listEventFiles(repoRoot);
    assert(evs.length === 1, `Step 1: expected 1 event, got ${evs.length}`);
    console.log("  ✓ Step 1 — DEC accept");
  }

  // ── Step 2 — DEC reject (b) → archives draft ──────────────────────
  {
    const repoRoot = mkRepoRoot();
    const draftPath = writeDraftDec(repoRoot, "DEC-1002");
    const ctx: McpContext = { repoRoot, sessionId: "session-b" };
    const result = await call(tool, ctx, {
      item_id: "DEC-1002",
      kind: "decision_draft",
      choice: "b",
      rationale: "outdated",
    });
    assert(result.resolved_kind === "decision_rejected", "Step 2: resolved_kind mismatch");
    assert(!existsSync(draftPath), "Step 2: draft should be moved out of inbox");
    assert(existsSync(join(repoRoot, ".archive")), "Step 2: archive dir should exist");
    console.log("  ✓ Step 2 — DEC reject");
  }

  // ── Step 3 — DEC edit (c) → returns body, no state change ────────
  {
    const repoRoot = mkRepoRoot();
    const draftPath = writeDraftDec(repoRoot, "DEC-1003");
    const ctx: McpContext = { repoRoot, sessionId: "session-c" };
    const result = await call(tool, ctx, {
      item_id: "DEC-1003",
      kind: "decision_draft",
      choice: "c",
    });
    assert(result.resolved_kind === "decision_edit_pending", "Step 3: resolved_kind mismatch");
    assert(typeof result.body === "string" && (result.body as string).length > 0, "Step 3: should return body");
    assert(existsSync(draftPath), "Step 3: draft should remain in inbox");
    console.log("  ✓ Step 3 — DEC edit (no-op)");
  }

  // ── Step 4 — Baseline suppress (b) → appends to suppressions.yaml ─
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "session-d" };
    const result = await call(tool, ctx, {
      item_id: "BASELINE-stub_catalog_hits-services/auth.ts",
      kind: "baseline_finding",
      choice: "b",
      rationale: "legacy code, intentional",
    });
    assert(result.resolved_kind === "baseline_suppressed", "Step 4: resolved_kind mismatch");
    const supp = join(repoRoot, ".harness", "baseline", "suppressions.yaml");
    assert(existsSync(supp), "Step 4: suppressions.yaml should be created");
    const body = readFileSync(supp, "utf8");
    assert(body.includes("BASELINE-stub_catalog_hits-services/auth.ts"), "Step 4: suppressed id should be in body");
    assert(body.includes("legacy code, intentional"), "Step 4: rationale should be persisted");
    console.log("  ✓ Step 4 — Baseline suppress");
  }

  // ── Step 5 — Baseline triage (a) and defer (c) → no-op responses ─
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "session-e" };
    const triage = await call(tool, ctx, {
      item_id: "BASELINE-x",
      kind: "baseline_finding",
      choice: "a",
    });
    assert(triage.resolved_kind === "baseline_triage", "Step 5a: triage path");
    const defer = await call(tool, ctx, {
      item_id: "BASELINE-y",
      kind: "baseline_finding",
      choice: "c",
    });
    assert(defer.resolved_kind === "baseline_deferred", "Step 5c: defer path");
    assert(!existsSync(join(repoRoot, ".harness", "baseline", "suppressions.yaml")), "Step 5: triage/defer must not write suppressions");
    console.log("  ✓ Step 5 — Baseline triage + defer");
  }

  // ── Step 6 — Invalidation event ack ────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "session-f" };
    const refresh = await call(tool, ctx, {
      item_id: "00000000001234-decision_drafted.json",
      kind: "invalidation_event",
      choice: "a",
    });
    assert(refresh.resolved_kind === "invalidation_refresh", "Step 6a");
    const cont = await call(tool, ctx, {
      item_id: "evt2",
      kind: "invalidation_event",
      choice: "b",
    });
    assert(cont.resolved_kind === "invalidation_continue_under_old", "Step 6b");
    const abort = await call(tool, ctx, {
      item_id: "evt3",
      kind: "invalidation_event",
      choice: "c",
    });
    assert(abort.resolved_kind === "invalidation_abort", "Step 6c");
    console.log("  ✓ Step 6 — Invalidation refresh/continue/abort");
  }

  // ── Step 7 — Errors — missing draft, malformed item_id ─────────────
  {
    const repoRoot = mkRepoRoot();
    const ctx: McpContext = { repoRoot, sessionId: "session-g" };
    const noDraft = await call(tool, ctx, {
      item_id: "DEC-9999",
      kind: "decision_draft",
      choice: "a",
    });
    assert(noDraft.ok === undefined, `Step 7: missing draft should error envelope, got ${JSON.stringify(noDraft)}`);
    const bad = await call(tool, ctx, {
      item_id: "not-a-dec",
      kind: "decision_draft",
      choice: "a",
    });
    assert(bad.ok === undefined, "Step 7: malformed item_id should error envelope");
    console.log("  ✓ Step 7 — error envelopes for invalid input");
  }

  console.log("smoke-resolve-attention — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
