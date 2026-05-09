#!/usr/bin/env tsx
/**
 * smoke-task-resume — verifies the Cairn-as-resume-layer plumbing:
 *
 *   1. `appendTaskJournal` writes to journal.jsonl with frontmatter
 *      schema validation.
 *   2. `readTaskJournal` round-trip parses appended entries.
 *   3. `findCurrentActiveTask` picks the most-recently-touched active
 *      task whose phase is in the active set.
 *   4. `checkContextThreshold` fires once when the transcript proxy
 *      crosses the model window fraction; suppresses re-fire within
 *      the same session until usage climbs another +10 %.
 *   5. SessionStart resume banner fires when the active task journal
 *      has entries from a different session id.
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
import { stringify as stringifyYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SESSION_START_BIN = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "dist",
  "hooks",
  "session-start.js",
);
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

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-task-resume-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.7.4\n", "utf8");
  return dir;
}

interface TaskFixture {
  taskId: string;
  taskDir: string;
}

function seedActiveTask(repoRoot: string, slug: string): TaskFixture {
  const taskId = `TSK-${slug}-${Math.random().toString(16).slice(2, 9)}`;
  const taskDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.yaml"),
    stringifyYaml({
      id: taskId,
      phase: "running",
      module: ".",
      title: slug,
      started_at: new Date().toISOString(),
    }),
    "utf8",
  );
  writeFileSync(
    join(taskDir, "spec.tightened.md"),
    `---\nid: ${taskId}\ntitle: ${slug}\nin_scope_decisions: []\nin_scope_invariants: []\n---\n\n# ${slug}\n\n## Goal\n\nTest goal body.\n`,
    "utf8",
  );
  return { taskId, taskDir };
}

function mkSession(repoRoot: string, sessionId: string): void {
  const sessionDir = join(repoRoot, ".cairn", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "events-marker.json"),
    JSON.stringify({ ts: Date.now() - 60_000, last_polled_ts: Date.now() - 60_000 }),
  );
  writeFileSync(
    join(sessionDir, "status.json"),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      decisions_in_scope: 0,
      invariants_in_scope: 0,
      task_state: "running",
      task_module: null,
      gc_running: false,
      attention_count: 0,
      bypass_count: 0,
    }),
  );
}

async function main(): Promise<void> {
  console.log("smoke-task-resume — start");

  const {
    appendTaskJournal,
    readTaskJournal,
    findCurrentActiveTask,
  } = await import(
    join(REPO_ROOT, "packages", "cairn-core", "dist", "tasks", "lifecycle.js")
  );
  const { checkContextThreshold } = await import(
    join(
      REPO_ROOT,
      "packages",
      "cairn-core",
      "dist",
      "hooks",
      "runners",
      "context-threshold.js",
    ),
  );

  // Step 1 — appendTaskJournal round-trip
  {
    const repo = mkRepoRoot();
    const fx = seedActiveTask(repo, "journal-roundtrip");
    const ok = appendTaskJournal({
      repoRoot: repo,
      taskId: fx.taskId,
      sessionId: "session-A",
      summary: "First entry",
      nextStep: "Do thing X",
    });
    assert(ok, "Step 1 — appendTaskJournal returned false");
    const entries = readTaskJournal(repo, fx.taskId);
    assert(entries.length === 1, `Step 1 — expected 1 entry, got ${entries.length}`);
    assert(entries[0].summary === "First entry", "Step 1 — summary mismatch");
    assert(entries[0].next_step === "Do thing X", "Step 1 — next_step mismatch");
    assert(entries[0].session_id === "session-A", "Step 1 — session_id mismatch");
    console.log("  ✓ Step 1 — journal append + read round-trip");
  }

  // Step 2 — append-only growth
  {
    const repo = mkRepoRoot();
    const fx = seedActiveTask(repo, "journal-growth");
    for (let i = 0; i < 5; i++) {
      appendTaskJournal({
        repoRoot: repo,
        taskId: fx.taskId,
        sessionId: "session-B",
        summary: `Entry ${i}`,
      });
    }
    const entries = readTaskJournal(repo, fx.taskId);
    assert(entries.length === 5, `Step 2 — expected 5, got ${entries.length}`);
    for (let i = 0; i < 5; i++) {
      assert(entries[i].summary === `Entry ${i}`, `Step 2 — order mismatch at ${i}`);
    }
    console.log("  ✓ Step 2 — append-only growth preserves order");
  }

  // Step 3 — findCurrentActiveTask
  {
    const repo = mkRepoRoot();
    assert(
      findCurrentActiveTask(repo) === null,
      "Step 3 — empty active dir should return null",
    );
    const a = seedActiveTask(repo, "first");
    // Make second task more recent by mtime
    await new Promise((r) => setTimeout(r, 30));
    const b = seedActiveTask(repo, "second");
    const found = findCurrentActiveTask(repo);
    assert(found === b.taskId, `Step 3 — expected ${b.taskId}, got ${found}`);
    // Touch a's status.yaml to make it newer
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(
      join(a.taskDir, "status.yaml"),
      stringifyYaml({
        id: a.taskId,
        phase: "running",
        module: ".",
        title: "first",
        bumped: true,
      }),
      "utf8",
    );
    const found2 = findCurrentActiveTask(repo);
    assert(found2 === a.taskId, `Step 3 — after bump, expected ${a.taskId}, got ${found2}`);
    console.log("  ✓ Step 3 — findCurrentActiveTask picks most-recently-touched");
  }

  // Step 4 — checkContextThreshold
  {
    const repo = mkRepoRoot();
    const sessionId = "session-ctx";
    mkSession(repo, sessionId);
    const transcriptPath = join(repo, "transcript.jsonl");
    // Below threshold — write a tiny transcript with explicit Sonnet model.
    const sonnetLine =
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" } }) +
      "\n";
    writeFileSync(transcriptPath, sonnetLine.repeat(10), "utf8");
    const miss = checkContextThreshold({
      transcriptPath,
      repoRoot: repo,
      sessionId,
    });
    assert(miss.hit === false, "Step 4 — small transcript should NOT cross threshold");

    // Above threshold for Sonnet (200k window, 50% = 100k tokens ≈ 400k bytes).
    // Pad with literal junk that still parses-to-skip on the readModel pass.
    const big = "x".repeat(500_000) + "\n" + sonnetLine;
    writeFileSync(transcriptPath, big, "utf8");
    const hit = checkContextThreshold({
      transcriptPath,
      repoRoot: repo,
      sessionId,
    });
    assert(hit.hit === true, "Step 4 — large transcript should cross threshold");
    if (hit.hit) {
      assert(hit.windowTokens === 200_000, `Step 4 — Sonnet window expected 200k, got ${hit.windowTokens}`);
      assert(hit.pct >= 50, `Step 4 — expected pct≥50, got ${hit.pct}`);
    }

    // Re-fire suppression: same call should now miss (warned-state stamped).
    const reMiss = checkContextThreshold({
      transcriptPath,
      repoRoot: repo,
      sessionId,
    });
    assert(reMiss.hit === false, "Step 4 — re-fire within same session should be suppressed");
    console.log("  ✓ Step 4 — context threshold fires once + suppresses re-fire");
  }

  // Step 5 — SessionStart resume banner
  {
    const repo = mkRepoRoot();
    const fx = seedActiveTask(repo, "resume-banner");
    appendTaskJournal({
      repoRoot: repo,
      taskId: fx.taskId,
      sessionId: "session-OLD",
      summary: "Implemented A in prior session",
      nextStep: "Now implement B",
    });

    // Run SessionStart with a NEW sessionId — banner should fire.
    const result = spawnSync("node", [SESSION_START_BIN], {
      input: JSON.stringify({ session_id: "session-NEW", cwd: repo }),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert(result.status === 0, `Step 5 — SessionStart exit ${result.status}: ${result.stderr}`);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    assert(
      ctx.includes(`Cairn — resuming \`${fx.taskId}\``),
      `Step 5 — resume banner missing in additionalContext: ${ctx.slice(0, 400)}`,
    );
    assert(
      ctx.includes("Implemented A in prior session"),
      "Step 5 — recent journal entry should appear in banner",
    );
    assert(
      ctx.includes("Now implement B"),
      "Step 5 — next_step should appear in banner",
    );
    console.log("  ✓ Step 5 — SessionStart fires resume banner on cross-session resume");
  }

  // Step 6 — same-session journal does NOT trigger resume banner
  {
    const repo = mkRepoRoot();
    const fx = seedActiveTask(repo, "same-session");
    appendTaskJournal({
      repoRoot: repo,
      taskId: fx.taskId,
      sessionId: "session-SAME",
      summary: "Continued work in same session",
    });
    const result = spawnSync("node", [SESSION_START_BIN], {
      input: JSON.stringify({ session_id: "session-SAME", cwd: repo }),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert(result.status === 0, `Step 6 — SessionStart exit ${result.status}`);
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const ctx = out.hookSpecificOutput?.additionalContext ?? "";
    assert(
      !ctx.includes("Cairn — resuming"),
      "Step 6 — resume banner should NOT fire when journal is same-session",
    );
    console.log("  ✓ Step 6 — same-session journal does NOT trigger resume banner");
  }

  console.log("smoke-task-resume — pass");
  cleanup();
}

main().catch((err: unknown) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
