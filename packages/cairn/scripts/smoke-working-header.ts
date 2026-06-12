#!/usr/bin/env tsx
/**
 * smoke-working-header — context engine, stage 1.
 *
 * Covers `buildWorkingHeader` (active task + mission + in-scope id
 * index) and the UserPromptSubmit runner's per-session dedup:
 *
 *   A. buildWorkingHeader renders the header for an active task with
 *      in-scope DEC/INV ids + goal.
 *   B. The UPS runner injects the header on first prompt, then SUPPRESSES
 *      it on an unchanged second prompt (seen.json fingerprint dedup).
 *   C. buildWorkingHeader renders a `Mission: … phase i/n "<title>"` line.
 *   D. No active task AND no mission → buildWorkingHeader returns null.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkingHeader,
  writeMissionState,
  writeRoadmap,
} from "@isaacriehm/cairn-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
// UPS runs via the umbrella `cairn hook user-prompt-submit` CLI route.
const CAIRN_BIN = join(REPO_ROOT, "packages", "cairn", "dist", "cli", "index.js");

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

function mkRepoRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-working-header-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.3.0\n", "utf8");
  return dir;
}

interface SeedTaskArgs {
  goal: string;
  decisions: string[];
  invariants: string[];
  /** Stamp `last_journal_session` so the affinity resolver can pick it. */
  lastJournalSession?: string;
}

function seedActiveTask(repoRoot: string, taskId: string, args: SeedTaskArgs): void {
  const taskDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  mkdirSync(taskDir, { recursive: true });
  const status =
    args.lastJournalSession !== undefined
      ? `phase: running\nlast_journal_session: ${args.lastJournalSession}\n`
      : "phase: running\n";
  writeFileSync(join(taskDir, "status.yaml"), status, "utf8");
  const fm = [
    "---",
    `title: ${taskId}`,
    "in_scope_decisions:",
    ...args.decisions.map((d) => `  - ${d}`),
    "in_scope_invariants:",
    ...args.invariants.map((i) => `  - ${i}`),
    "target_path_globs:",
    "  - src/**",
    "---",
    "",
    `# ${taskId}`,
    "",
    "## Goal",
    "",
    args.goal,
    "",
  ].join("\n");
  writeFileSync(join(taskDir, "spec.tightened.md"), fm, "utf8");
}

function runUps(
  repoRoot: string,
  sessionId: string,
  prompt: string,
): string {
  // Ensure the per-session dir exists so seen.json has a home.
  mkdirSync(join(repoRoot, ".cairn", "sessions", sessionId), { recursive: true });
  const result = spawnSync("node", [CAIRN_BIN, "hook", "user-prompt-submit"], {
    input: JSON.stringify({ session_id: sessionId, cwd: repoRoot, prompt }),
    encoding: "utf8",
    timeout: 5000,
  });
  const stdout = result.stdout ?? "";
  try {
    const out = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return out.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

const HEADER_MARK = "## Cairn — working context";

function main(): void {
  console.log("smoke-working-header — start");
  assert(
    existsSync(CAIRN_BIN),
    `expected compiled cairn CLI at ${CAIRN_BIN} (run pnpm build first)`,
  );

  // ── A — buildWorkingHeader renders active task + in-scope ids ───────
  {
    const repo = mkRepoRoot("a");
    const taskId = "TSK-headera-1234567";
    seedActiveTask(repo, taskId, {
      goal: "Make the widget render twice as fast under cold cache",
      decisions: ["DEC-aaaaaaa", "DEC-bbbbbbb"],
      invariants: ["INV-ccccccc"],
    });
    const wh = buildWorkingHeader(repo, null);
    assert(wh !== null, "A: header should be non-null with an active task");
    assert(wh.text.includes(HEADER_MARK), "A: header missing the marker line");
    assert(wh.text.includes(taskId), "A: header should name the active task id");
    assert(wh.text.includes("DEC-aaaaaaa"), "A: header missing in-scope DEC");
    assert(wh.text.includes("INV-ccccccc"), "A: header missing in-scope INV");
    assert(wh.text.includes("render twice"), "A: header missing goal text");
    assert(wh.fingerprint.length > 0, "A: header should carry a fingerprint");
    console.log("  ✓ A — buildWorkingHeader renders active task + in-scope ids");
  }

  // ── B — UPS runner injects once, dedupes on unchanged repeat ────────
  {
    const repo = mkRepoRoot("b");
    seedActiveTask(repo, "TSK-headerb-7654321", {
      goal: "Tighten the dedup path",
      decisions: ["DEC-ddddddd"],
      invariants: [],
    });
    const sid = "sess-working-header-b";
    const first = runUps(repo, sid, "do the thing, no at-sign here");
    assert(first.includes(HEADER_MARK), "B: first prompt should inject the header");
    const second = runUps(repo, sid, "do another thing, still no at-sign");
    assert(
      !second.includes(HEADER_MARK),
      "B: unchanged second prompt must NOT re-inject the header (dedup)",
    );
    console.log("  ✓ B — UPS injects header once, suppresses unchanged repeat");
  }

  // ── C — mission line: phase i/n with title ──────────────────────────
  {
    const repo = mkRepoRoot("c");
    const missionId = "MIS-smoke-0abcdef";
    writeRoadmap(
      repo,
      missionId,
      {
        mission_id: missionId,
        title: "Smoke Mission",
        spec_path: ".cairn/ground/missions/smoke/spec.md",
        created_at: "2026-01-01T00:00:00Z",
        exit_gate: "manual",
        phases: [
          { id: "phase-one", title: "First", depends_on: [], exit_criteria: "done" },
          { id: "phase-two", title: "Second", depends_on: [], exit_criteria: "done" },
        ],
      },
      "",
    );
    writeMissionState(repo, missionId, {
      mission_id: missionId,
      started_at: "2026-01-01T00:00:00Z",
      cursor: { active_phase: "phase-two", active_phase_started_at: null },
      phase_progress: {},
      outcome: "active",
    });
    const wh = buildWorkingHeader(repo, null);
    assert(wh !== null, "C: header should be non-null with an active mission");
    assert(
      wh.text.includes("Mission: Smoke Mission"),
      "C: header missing mission title",
    );
    assert(
      wh.text.includes('phase 2/2 "Second"'),
      "C: header missing phase i/n + title",
    );
    console.log('  ✓ C — mission line renders phase 2/2 "Second"');
  }

  // ── D — no task, no mission → null ──────────────────────────────────
  {
    const repo = mkRepoRoot("d");
    assert(
      buildWorkingHeader(repo, null) === null,
      "D: empty repo (no task, no mission) must yield null",
    );
    console.log("  ✓ D — no task + no mission → null");
  }

  // ── E — multi-task: header shows the task THIS session owns ─────────
  {
    const repo = mkRepoRoot("e");
    seedActiveTask(repo, "TSK-mine-1111111", {
      goal: "Wire the session-owned widget",
      decisions: ["DEC-mineaaa"],
      invariants: [],
      lastJournalSession: "sess-mine",
    });
    seedActiveTask(repo, "TSK-other-2222222", {
      goal: "Unrelated parallel work",
      decisions: ["DEC-otherbb"],
      invariants: [],
      lastJournalSession: "sess-other",
    });
    const mine = buildWorkingHeader(repo, "sess-mine");
    assert(mine !== null, "E: header should resolve for the owning session");
    assert(mine.text.includes("TSK-mine-1111111"), "E: should show the session's own task");
    assert(mine.text.includes("DEC-mineaaa"), "E: should show the own task's in-scope ids");
    assert(
      !mine.text.includes("TSK-other-2222222") && !mine.text.includes("DEC-otherbb"),
      "E: must NOT leak the other session's task / ids",
    );
    // The other session sees ITS task, from the same repo.
    const other = buildWorkingHeader(repo, "sess-other");
    assert(
      other !== null && other.text.includes("TSK-other-2222222"),
      "E: a different session resolves its own task",
    );
    console.log("  ✓ E — multi-task: each session's header shows its own task");
  }

  cleanup();
  console.log("smoke-working-header — pass");
}

main();
