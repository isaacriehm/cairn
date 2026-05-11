#!/usr/bin/env tsx
/**
 * smoke-phase-ready-surface — verifies the dual-channel phase-ready
 * surface introduced when the Stop hook stopped using
 * `decision: block` for phase-ready (the CC "Stop hook error" frame
 * was operator-hostile for an informational prompt).
 *
 * Channels covered:
 *   1. `writePhaseReadyPending` writes the session-scoped pending
 *      file with the expected schema.
 *   2. `readAndConsumePhaseReadyPending` returns the hints + deletes
 *      the file in one shot (consume-once semantics).
 *   3. `renderPhaseReadyHint` produces operator-facing markdown with
 *      the plain-English option labels (no `(choice: "...")` tail,
 *      no `Defer 24h` option, phase TITLE in the question).
 *   4. UserPromptSubmit hook end-to-end: write pending file → spawn
 *      `cairn hook user-prompt-submit` with matching session_id →
 *      assert stdout's `additionalContext` carries the render and
 *      the pending file was deleted.
 *   5. UPS with no pending file emits empty `additionalContext`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
// UPS runs via the umbrella `cairn hook user-prompt-submit` CLI route
// (no standalone bin for this event today — `hooks.json` invokes the
// same path through the plugin bundle).
const CAIRN_BIN = join(
  REPO_ROOT,
  "packages",
  "cairn",
  "dist",
  "cli",
  "index.js",
);

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-phase-ready-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "config.yaml"),
    "cairn_version: 0.3.0\n",
    "utf8",
  );
  return dir;
}

function mkSessionDir(repoRoot: string, sessionId: string): string {
  const dir = join(repoRoot, ".cairn", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runUps(
  repoRoot: string,
  sessionId: string,
  prompt: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("node", [CAIRN_BIN, "hook", "user-prompt-submit"], {
    input: JSON.stringify({ session_id: sessionId, cwd: repoRoot, prompt }),
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

interface UpsOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

function parseUpsOutput(stdout: string): UpsOutput {
  return JSON.parse(stdout.trim()) as UpsOutput;
}

function additionalContextOf(out: UpsOutput): string {
  return out.hookSpecificOutput?.additionalContext ?? "";
}

async function main(): Promise<void> {
  console.log("smoke-phase-ready-surface — start");
  assert(
    existsSync(CAIRN_BIN),
    `expected compiled cairn CLI at ${CAIRN_BIN} (run pnpm -r build first)`,
  );

  const {
    writePhaseReadyPending,
    readAndConsumePhaseReadyPending,
    renderPhaseReadyHint,
  } = await import(
    join(
      REPO_ROOT,
      "packages",
      "cairn-core",
      "dist",
      "hooks",
      "runners",
      "phase-ready-surface.js",
    )
  );

  // ── Step 1 — writePhaseReadyPending creates the session-scoped file
  {
    const repo = mkRepoRoot();
    const sessionId = "session-step1";
    mkSessionDir(repo, sessionId);
    const hints = [
      {
        mission_id: "MIS-test-1234567",
        mission_title: "Test mission",
        phase_id: "phase-a",
        phase_title: "Phase A",
        exit_criteria: "Foo migrated. Bar deleted.",
      },
    ];
    writePhaseReadyPending(repo, sessionId, hints);
    const path = join(
      repo,
      ".cairn",
      "sessions",
      sessionId,
      "phase-ready-pending.json",
    );
    assert(existsSync(path), "Step 1 — pending file should be created");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    assert(
      Array.isArray(parsed["hints"]),
      "Step 1 — pending file must carry hints array",
    );
    assert(
      parsed["session_id"] === sessionId,
      "Step 1 — pending file must carry session_id",
    );
    console.log("  ✓ Step 1 — writePhaseReadyPending writes session file");
  }

  // ── Step 2 — readAndConsume returns hints + deletes file
  {
    const repo = mkRepoRoot();
    const sessionId = "session-step2";
    mkSessionDir(repo, sessionId);
    const hints = [
      {
        mission_id: "MIS-x-1234567",
        mission_title: "M",
        phase_id: "p",
        phase_title: "P",
        exit_criteria: "ec",
      },
    ];
    writePhaseReadyPending(repo, sessionId, hints);
    const path = join(
      repo,
      ".cairn",
      "sessions",
      sessionId,
      "phase-ready-pending.json",
    );
    const consumed = readAndConsumePhaseReadyPending(repo, sessionId);
    assert(
      Array.isArray(consumed) && consumed.length === 1,
      "Step 2 — readAndConsume should return the hints",
    );
    assert(
      !existsSync(path),
      "Step 2 — pending file should be deleted after read",
    );
    const consumedAgain = readAndConsumePhaseReadyPending(repo, sessionId);
    assert(
      consumedAgain === null,
      "Step 2 — second read should return null (consume-once)",
    );
    console.log("  ✓ Step 2 — readAndConsume returns + unlinks pending file");
  }

  // ── Step 3 — renderPhaseReadyHint produces clean operator markdown
  {
    const rendered = renderPhaseReadyHint([
      {
        mission_id: "MIS-foo-1234567",
        mission_title: "Foo mission",
        phase_id: "wave-1",
        phase_title: "Wave 1",
        exit_criteria: "CN1 + DL1 + CALL1 merged",
      },
    ]);
    assert(rendered.length > 0, "Step 3 — render should produce text");
    assert(
      rendered.includes("Wave 1"),
      "Step 3 — render should include phase TITLE in the question",
    );
    assert(
      rendered.includes("Move on?"),
      "Step 3 — render should ask the operator question",
    );
    assert(
      !/\(choice: "[^"]+"\)/.test(rendered),
      "Step 3 — render should NOT expose tool-call syntax in option labels",
    );
    assert(
      !/[Dd]efer 24h/.test(rendered),
      "Step 3 — render should NOT include the Defer 24h option",
    );
    assert(
      rendered.includes("Mark phase done"),
      "Step 3 — render should keep human-readable [a] label",
    );
    assert(
      rendered.includes("Keep working on this phase"),
      "Step 3 — render should keep human-readable [b] label",
    );
    console.log("  ✓ Step 3 — renderPhaseReadyHint produces operator markdown");
  }

  // ── Step 4 — UPS hook end-to-end consumes pending + injects context
  {
    const repo = mkRepoRoot();
    const sessionId = "session-step4";
    mkSessionDir(repo, sessionId);
    const hints = [
      {
        mission_id: "MIS-bar-1234567",
        mission_title: "Bar mission",
        phase_id: "wave-2",
        phase_title: "Wave 2",
        exit_criteria: "Telephony + live-call shipped",
      },
    ];
    writePhaseReadyPending(repo, sessionId, hints);
    const out = runUps(repo, sessionId, "what next?");
    assert(
      out.status === 0,
      `Step 4 — UPS should exit 0, got ${out.status}; stderr=${out.stderr}`,
    );
    const parsed = parseUpsOutput(out.stdout);
    const ctx = additionalContextOf(parsed);
    assert(
      ctx.includes("Wave 2"),
      `Step 4 — additionalContext should carry phase title, got: ${ctx.slice(0, 200)}`,
    );
    assert(
      ctx.includes("Telephony + live-call shipped"),
      "Step 4 — additionalContext should carry exit criteria",
    );
    const pendingPath = join(
      repo,
      ".cairn",
      "sessions",
      sessionId,
      "phase-ready-pending.json",
    );
    assert(
      !existsSync(pendingPath),
      "Step 4 — pending file must be deleted after UPS consumes",
    );
    console.log("  ✓ Step 4 — UPS hook injects phase-ready as additionalContext");
  }

  // ── Step 5 — UPS with no pending file emits empty context
  {
    const repo = mkRepoRoot();
    const sessionId = "session-step5";
    mkSessionDir(repo, sessionId);
    const out = runUps(repo, sessionId, "no @ tokens here");
    assert(out.status === 0, `Step 5 — UPS should exit 0, got ${out.status}`);
    const parsed = parseUpsOutput(out.stdout);
    const ctx = additionalContextOf(parsed);
    assert(
      ctx === "",
      `Step 5 — additionalContext should be empty when no pending file, got: ${ctx.slice(0, 100)}`,
    );
    console.log("  ✓ Step 5 — UPS emits empty context when no pending file");
  }

  console.log("smoke-phase-ready-surface — pass");
  cleanup();
}

main().catch((err) => {
  console.error("✗ smoke-phase-ready-surface failed:", err);
  cleanup();
  process.exit(1);
});
