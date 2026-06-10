/**
 * Context-threshold detection for the Stop hook.
 *
 * When mid-task context approaches the active model's window, surface
 * an inline `[a] keep going  [b] /clear and resume now  [c] mark task
 * done` choice via Claude Code's AskUserQuestion. The Stop hook can't
 * call AskUserQuestion directly (only the model can), so it injects
 * `decision: block` with an instructional reason that prompts main
 * Claude to render the question.
 *
 * Single source of truth: Claude Code's statusline payload ships a
 * `context_window` block with `total_tokens` (the active model's
 * window — 200k Sonnet, 1M Opus-1m) + `remaining_percentage`. The
 * statusline hook persists those numbers to
 * `.cairn/sessions/<id>/ctx.json` on every prompt. The Stop hook reads
 * that snapshot — there is no model-keyed fallback and no transcript-
 * usage estimator. If CC omits the block, ctx.json is absent or stale
 * and the threshold check stays silent rather than firing on a guess.
 *
 * Threshold defaults to 50 % of CC's reported window.
 *
 * Suppress re-fire within the same session by stamping
 * `.cairn/sessions/<id>/ctx-threshold-warned.json`. Once stamped, the
 * threshold prompt re-fires only when usage climbs another +10 %
 * past the last warning.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { cairnDir } from "@isaacriehm/cairn-state";

export interface ContextThresholdInput {
  repoRoot: string;
  sessionId: string;
  /** Override the threshold fraction (default 0.5). */
  thresholdFraction?: number;
}

export interface ContextThresholdHit {
  hit: true;
  usedTokens: number;
  windowTokens: number;
  pct: number;
  taskId: string | null;
}

export interface ContextThresholdMiss {
  hit: false;
}

export type ContextThresholdResult = ContextThresholdHit | ContextThresholdMiss;

interface CtxSnapshot {
  usedPct: number;
  usedTokens: number;
  windowTokens: number;
  ts: number;
}

const CTX_SNAPSHOT_STALE_MS = 5 * 60 * 1000;

/**
 * Read the latest persisted ctx snapshot from the statusline writer.
 * Statusline runs on every prompt so a fresh snapshot is normally
 * <1s old. Returns null when missing, malformed, or older than 5min
 * (e.g. session crashed, statusline hook misconfigured, or CC did
 * not ship a `context_window` block on the last prompt).
 */
function readPersistedCtx(repoRoot: string, sessionId: string): CtxSnapshot | null {
  const path = cairnDir(repoRoot, "sessions", sessionId, "ctx.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CtxSnapshot;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.usedPct === "number" &&
      typeof parsed.usedTokens === "number" &&
      typeof parsed.windowTokens === "number" &&
      parsed.windowTokens > 0 &&
      typeof parsed.ts === "number"
    ) {
      if (Date.now() - parsed.ts > CTX_SNAPSHOT_STALE_MS) return null;
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

interface WarnedState {
  /** ms epoch of last threshold fire. */
  ts: number;
  /** Token count at last fire (used to suppress until +10% climb). */
  warned_at_tokens: number;
}

function warnedStatePath(repoRoot: string, sessionId: string): string {
  return cairnDir(repoRoot,
    "sessions",
    sessionId,
    "ctx-threshold-warned.json",
  );
}

function readWarned(repoRoot: string, sessionId: string): WarnedState | null {
  const path = warnedStatePath(repoRoot, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WarnedState;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.ts === "number" &&
      typeof parsed.warned_at_tokens === "number"
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

function writeWarned(
  repoRoot: string,
  sessionId: string,
  state: WarnedState,
): void {
  try {
    writeFileSync(
      warnedStatePath(repoRoot, sessionId),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // best-effort
  }
}

/**
 * Returns the current threshold result. Stamps the warned-state file
 * on a hit so re-fires within the same session are suppressed until
 * usage climbs another +10 % of the window.
 */
export function checkContextThreshold(
  input: ContextThresholdInput,
): ContextThresholdResult {
  const snapshot = readPersistedCtx(input.repoRoot, input.sessionId);
  if (snapshot === null) return { hit: false };

  const windowTokens = snapshot.windowTokens;
  const fraction = input.thresholdFraction ?? 0.5;
  const thresholdTokens = Math.floor(windowTokens * fraction);

  if (snapshot.usedTokens < thresholdTokens) return { hit: false };

  const warned = readWarned(input.repoRoot, input.sessionId);
  const reFireSlackTokens = Math.floor(windowTokens * 0.1);
  if (warned !== null && snapshot.usedTokens < warned.warned_at_tokens + reFireSlackTokens) {
    return { hit: false };
  }

  writeWarned(input.repoRoot, input.sessionId, {
    ts: Date.now(),
    warned_at_tokens: snapshot.usedTokens,
  });

  return {
    hit: true,
    usedTokens: snapshot.usedTokens,
    windowTokens,
    pct: Math.min(100, Math.round((snapshot.usedTokens / windowTokens) * 100)),
    taskId: null,
  };
}

/**
 * Render the inline prompt that the Stop hook injects via
 * `decision: block`. When an active task is in flight, the prompt
 * surfaces three options (keep going / clear+resume / mark done) and
 * emits the literal `/cairn:cairn-resume <task_id>` token for the `[b]`
 * branch. When no active task is in flight (e.g. the auto-graduator
 * just moved the only active task to `done/` this same Stop tick),
 * the resume + mark-done options are dropped to avoid offering a
 * resume that `cairn_resume` would error on.
 */
export function renderContextThresholdHint(
  hit: ContextThresholdHit,
  taskId: string | null,
): string {
  const header = [
    `## Cairn — context threshold reached`,
    "",
    `**${hit.usedTokens.toLocaleString()} / ${hit.windowTokens.toLocaleString()} tokens (${hit.pct}%)** in use. Trust degrades as context climbs — best to compact now.`,
    "",
  ];

  if (taskId === null) {
    return [
      ...header,
      "No active task — context climbed through general work, or the active task just graduated this tick. Nothing to resume from.",
      "",
      "When you reach a stopping point, surface to operator (e.g. via `AskUserQuestion`); if mid-flow, finish first:",
      "",
      "> Context at " + hit.pct + "% of window. Pick:",
      "> ",
      "> - `[a]` keep going (warn re-fires every +10 %)",
      "> - `[b]` `/clear` and start fresh (no task to resume)",
      "",
      "On `[b]`, instruct the operator to run `/clear`. On `[a]`, just continue.",
    ].join("\n");
  }

  return [
    ...header,
    `Active task: \`${taskId}\`.`,
    "",
    "When you reach a stopping point, surface to operator (e.g. via `AskUserQuestion`); if mid-flow, finish first:",
    "",
    "> Context at " + hit.pct + "% of window. Pick:",
    "> ",
    "> - `[a]` keep going (warn re-fires every +10 %)",
    "> - `[b]` `/clear` and resume now (Cairn writes the resume prompt)",
    "> - `[c]` mark task done (graduate the active TSK and start fresh)",
    "",
    `If the operator picks **\`b\`**, emit a code block containing exactly:\n\n\`\`\`\n/cairn:cairn-resume ${taskId}\n\`\`\`\n\nThe operator copies that, runs \`/clear\`, then pastes it into the fresh chat — Cairn rebuilds context from \`.cairn/tasks/active/${taskId}/journal.jsonl\`.`,
    "",
    "On `[c]`, call `cairn_task_complete({task_id, outcome: \"succeeded\"})` for the active task before ending the turn. On `[a]`, just continue.",
  ].join("\n");
}
