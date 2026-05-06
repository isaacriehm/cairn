#!/usr/bin/env tsx
/**
 * smoke-stop-hook — verifies runStopHook drains events, scans for
 * tasks pending review, and surfaces a reviewer-spawn hint in
 * additionalContext when appropriate.
 *
 * Spec: PLUGIN_ARCHITECTURE §10 (Stop hook).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const STOP_BIN = join(REPO_ROOT, "packages", "cairn-core", "dist", "hooks", "stop.js");

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

function mkRepoRoot(sessionId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-stop-"));
  cleanups.push(dir);
  // `.cairn/config.yaml` — `resolveRepoRoot` requires it to
  // distinguish a real adopted project from template content
  // (`cairn-core/templates/.cairn/`).
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.3.0\n", "utf8");
  // .cairn/sessions/<sessionId>/events-marker.json — pretend
  // SessionStart already armed the watch.
  const sessionDir = join(dir, ".cairn", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "events-marker.json"),
    JSON.stringify({ ts: Date.now() - 60_000, last_polled_ts: Date.now() - 60_000 }, null, 2),
  );
  // status.json baseline
  writeFileSync(
    join(sessionDir, "status.json"),
    JSON.stringify(
      {
        updated_at: new Date(Date.now() - 30_000).toISOString(),
        decisions_in_scope: 0,
        invariants_in_scope: 0,
        task_state: "idle",
        task_module: null,
        gc_running: false,
        attention_count: 0,
        last_run_result: null,
        last_run_at: null,
      },
      null,
      2,
    ),
  );
  return dir;
}

function runStopHook(repoRoot: string, sessionId: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [STOP_BIN], {
    input: JSON.stringify({ session_id: sessionId, cwd: repoRoot }),
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

/** Pass — nothing to surface. */
interface StopPassOutput {
  continue: true;
}

/** Block — injects reason into Claude's context via decision:block. */
interface StopBlockOutput {
  decision: "block";
  reason: string;
}

type HookOutput = StopPassOutput | StopBlockOutput;

/** Returns the Claude-facing reason text, or "" when nothing surfaced. */
function ctxOf(out: HookOutput): string {
  return "reason" in out ? out.reason : "";
}

function parseOutput(stdout: string): HookOutput {
  return JSON.parse(stdout.trim()) as HookOutput;
}

function writeTightenedSpec(repoRoot: string, taskId: string, opts: { withAttestation?: boolean; ageMs?: number } = {}): void {
  const taskDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  mkdirSync(taskDir, { recursive: true });
  const spec = `---\nid: ${taskId}\nstatus: ready\n---\n\n# ${taskId}\n\nbody.\n`;
  writeFileSync(join(taskDir, "spec.tightened.md"), spec, "utf8");
  if (opts.ageMs !== undefined) {
    const ts = (Date.now() - opts.ageMs) / 1000;
    utimesSync(join(taskDir, "spec.tightened.md"), ts, ts);
  }
  if (opts.withAttestation === true) {
    writeFileSync(
      join(taskDir, "attestation.yaml"),
      `task_id: ${taskId}\nattested_at: ${new Date().toISOString()}\nattested_by: reviewer\n`,
      "utf8",
    );
  }
}

function runSmoke(): void {
  console.log("smoke-stop-hook — start");
  assert(existsSync(STOP_BIN), `expected compiled stop bin at ${STOP_BIN} (run pnpm -r build first)`);

  // ── Step 1 — empty repo: no block, no reason ─────────────────────
  {
    const repoRoot = mkRepoRoot("session-empty");
    const out = runStopHook(repoRoot, "session-empty");
    assert(out.status === 0, `Step 1: exit 0 expected, got ${out.status}; stderr=${out.stderr}`);
    const parsed = parseOutput(out.stdout);
    assert(ctxOf(parsed) === "", "Step 1: reason should be empty when nothing to surface");
    console.log("  ✓ Step 1 — empty repo → no block");
  }

  // ── Step 2 — task pending review blocks stop with reason ─────────
  {
    const repoRoot = mkRepoRoot("session-pending");
    writeTightenedSpec(repoRoot, "TSK-2026-05-04-test-12345");
    const out = runStopHook(repoRoot, "session-pending");
    assert(out.status === 0, `Step 2: exit 0 expected, got ${out.status}; stderr=${out.stderr}`);
    const parsed = parseOutput(out.stdout);
    assert("decision" in parsed && parsed.decision === "block", "Step 2: should emit decision:block");
    assert(/awaiting review attestation/.test(ctxOf(parsed)), `Step 2: reason missing reviewer hint, got: ${ctxOf(parsed)}`);
    assert(ctxOf(parsed).includes("TSK-2026-05-04-test-12345"), "Step 2: task id should appear");
    assert(/cairn-attention/.test(ctxOf(parsed)), "Step 2: hint should instruct cairn-attention skill invocation");
    console.log("  ✓ Step 2 — pending review blocks stop");
  }

  // ── Step 3 — task with attestation does NOT surface ──────────────
  {
    const repoRoot = mkRepoRoot("session-attested");
    writeTightenedSpec(repoRoot, "TSK-attested", { withAttestation: true });
    const out = runStopHook(repoRoot, "session-attested");
    const parsed = parseOutput(out.stdout);
    assert(ctxOf(parsed) === "", `Step 3: attested task should not surface, got: ${ctxOf(parsed)}`);
    console.log("  ✓ Step 3 — attested task suppressed");
  }

  // ── Step 4 — stale task (>6h) does NOT surface ───────────────────
  {
    const repoRoot = mkRepoRoot("session-stale");
    writeTightenedSpec(repoRoot, "TSK-stale", { ageMs: 7 * 60 * 60 * 1000 });
    const out = runStopHook(repoRoot, "session-stale");
    const parsed = parseOutput(out.stdout);
    assert(ctxOf(parsed) === "", `Step 4: stale task should not surface, got: ${ctxOf(parsed)}`);
    console.log("  ✓ Step 4 — stale task suppressed (>6h)");
  }

  // ── Step 5 — multiple pending tasks: all listed ──────────────────
  {
    const repoRoot = mkRepoRoot("session-multi");
    writeTightenedSpec(repoRoot, "TSK-A");
    writeTightenedSpec(repoRoot, "TSK-B");
    writeTightenedSpec(repoRoot, "TSK-C", { withAttestation: true });
    const out = runStopHook(repoRoot, "session-multi");
    const parsed = parseOutput(out.stdout);
    const ctx = ctxOf(parsed);
    assert(ctx.includes("TSK-A"), "Step 5: TSK-A should surface");
    assert(ctx.includes("TSK-B"), "Step 5: TSK-B should surface");
    assert(!ctx.includes("TSK-C"), "Step 5: TSK-C (attested) should NOT surface");
    assert(/2 tasks awaiting review attestation/.test(ctx), `Step 5: header should report 2 tasks; got: ${ctx}`);
    console.log("  ✓ Step 5 — multiple pending tasks listed correctly");
  }

  console.log("smoke-stop-hook — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
