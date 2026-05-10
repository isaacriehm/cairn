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
 * Threshold defaults to 50 % of the active model's window:
 *   - claude-opus-*    → 1_000_000 tokens, fire at 500_000
 *   - claude-sonnet-*  →   200_000 tokens, fire at 100_000
 *   - claude-haiku-*   →   200_000 tokens, fire at 100_000
 *   - unknown model    → assume Opus shape (1M / 500k threshold)
 *
 * Token count is estimated from the transcript file size (`bytes / 4`)
 * — overcounts a little on JSON whitespace, undercounts on unicode-
 * heavy turns. Good enough to fire near the threshold; not a budget
 * check.
 *
 * Suppress re-fire within the same session by stamping
 * `.cairn/sessions/<id>/ctx-threshold-warned.json`. Once stamped, the
 * threshold prompt re-fires only when usage climbs another +10 %
 * past the last warning.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ContextThresholdInput {
  transcriptPath: string | null;
  repoRoot: string;
  sessionId: string;
  /** Override the model lookup (rarely needed). */
  modelOverride?: string | null;
  /** Override the threshold fraction (default 0.5). */
  thresholdFraction?: number;
  /** Override the window size in tokens (default keyed on model). */
  windowOverride?: number;
}

export interface ContextThresholdHit {
  hit: true;
  estimatedTokens: number;
  windowTokens: number;
  pct: number;
  model: string;
  taskId: string | null;
}

export interface ContextThresholdMiss {
  hit: false;
}

export type ContextThresholdResult = ContextThresholdHit | ContextThresholdMiss;

const MODEL_WINDOW_FALLBACK = 1_000_000;

export function modelWindow(model: string): number {
  // Opus 4.7 ships with a 1M-token window when the `[1m]` variant is
  // selected; the base alias still resolves to 200k. Treat any model
  // string that contains `1m` (the variant suffix Claude Code prints)
  // as the 1M tier so the statusline percentage reads correctly.
  if (/1m/i.test(model)) return 1_000_000;
  if (/opus/i.test(model)) return 1_000_000;
  if (/sonnet/i.test(model)) return 200_000;
  if (/haiku/i.test(model)) return 200_000;
  return MODEL_WINDOW_FALLBACK;
}

/**
 * Walk the last ~64 KB of the transcript looking for the most recent
 * `model` field. Claude Code transcript lines are JSON; each assistant
 * turn carries a `message.model` string. Skipping the full file keeps
 * the hook fast on long sessions.
 */
export function readModelFromTranscript(path: string): string | null {
  try {
    const stat = statSync(path);
    const tail = Math.min(stat.size, 65_536);
    const fd = readFileSync(path, "utf8");
    const slice = fd.slice(Math.max(0, fd.length - tail));
    const lines = slice.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as { message?: { model?: string } };
        const m = obj.message?.model;
        if (typeof m === "string" && m.length > 0) return m;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface CtxSnapshot {
  usedPct: number;
  usedTokens: number;
  ts: number;
}

const CTX_SNAPSHOT_STALE_MS = 5 * 60 * 1000;

/**
 * Read the latest persisted ctx snapshot from the statusline writer.
 * Statusline runs on every prompt so a fresh snapshot is normally
 * <1s old. Returns null when missing, malformed, or older than 5min
 * (e.g. session crashed, statusline hook misconfigured).
 */
function readPersistedCtx(repoRoot: string, sessionId: string): CtxSnapshot | null {
  const path = join(repoRoot, ".cairn", "sessions", sessionId, "ctx.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CtxSnapshot;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.usedPct === "number" &&
      typeof parsed.usedTokens === "number" &&
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

/**
 * Fallback estimator when no persisted ctx snapshot is available.
 *
 * Walks the last ~256 KB of the transcript backward looking for the
 * most recent `message.usage` block from an assistant turn. Claude
 * Code transcript lines are JSON; assistant turns carry an exact token
 * count under `message.usage.{input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens}` — summing those three gives the actual
 * prompt size at that turn (output_tokens are produced, not consumed
 * by context).
 *
 * Returns null when no usage block is found (e.g. fresh session, no
 * assistant turn yet). Caller can choose to skip threshold check or
 * fall back to bytes/4. We never fall back here — bytes/4 over-counts
 * 1.5–2x because the transcript JSONL accumulates every tool I/O blob
 * since session start, which is what produced the 113%-of-window bug.
 */
export function estimateTokensFromTranscript(transcriptPath: string): number | null {
  try {
    const stat = statSync(transcriptPath);
    const tail = Math.min(stat.size, 262_144);
    const fd = readFileSync(transcriptPath, "utf8");
    const slice = fd.slice(Math.max(0, fd.length - tail));
    const lines = slice.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: {
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
        };
        const u = obj.message?.usage;
        if (u === undefined) continue;
        const i_t = typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const cc = typeof u.cache_creation_input_tokens === "number"
          ? u.cache_creation_input_tokens
          : 0;
        const cr = typeof u.cache_read_input_tokens === "number"
          ? u.cache_read_input_tokens
          : 0;
        const total = i_t + cc + cr;
        if (total > 0) return total;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return null;
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
  return join(
    repoRoot,
    ".cairn",
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
  if (input.transcriptPath === null || input.transcriptPath.length === 0) {
    return { hit: false };
  }
  if (!existsSync(input.transcriptPath)) return { hit: false };

  const model =
    input.modelOverride ?? readModelFromTranscript(input.transcriptPath) ?? "unknown";
  const windowTokens = input.windowOverride ?? modelWindow(model);
  const fraction = input.thresholdFraction ?? 0.5;
  const thresholdTokens = Math.floor(windowTokens * fraction);

  const snapshot = readPersistedCtx(input.repoRoot, input.sessionId);
  const fallback = estimateTokensFromTranscript(input.transcriptPath);
  // Skip the check when neither source is available — better to stay
  // silent than fire on bytes/4 garbage like we used to.
  if (snapshot === null && fallback === null) return { hit: false };
  const estimated = snapshot !== null ? snapshot.usedTokens : (fallback ?? 0);
  if (estimated < thresholdTokens) return { hit: false };

  const warned = readWarned(input.repoRoot, input.sessionId);
  const reFireSlackTokens = Math.floor(windowTokens * 0.1);
  if (warned !== null && estimated < warned.warned_at_tokens + reFireSlackTokens) {
    return { hit: false };
  }

  writeWarned(input.repoRoot, input.sessionId, {
    ts: Date.now(),
    warned_at_tokens: estimated,
  });

  return {
    hit: true,
    estimatedTokens: estimated,
    windowTokens,
    pct: Math.min(100, Math.round((estimated / windowTokens) * 100)),
    model,
    taskId: null,
  };
}

/**
 * Render the inline prompt that the Stop hook injects via
 * `decision: block`. When an active task is in flight, the prompt
 * surfaces three options (keep going / clear+resume / mark done) and
 * emits the literal `/cairn-resume <task_id>` token for the `[b]`
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
    `Estimated **${hit.estimatedTokens.toLocaleString()} / ${hit.windowTokens.toLocaleString()} tokens (${hit.pct}%)** for \`${hit.model}\`. Trust degrades as context climbs — best to compact now.`,
    "",
  ];

  if (taskId === null) {
    return [
      ...header,
      "No active task — context climbed through general work, or the active task just graduated this tick. Nothing to resume from.",
      "",
      "Render this question via the `AskUserQuestion` tool — do not skip:",
      "",
      "> Context at " + hit.pct + "% of " + hit.model + " window. Pick:",
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
    "Render this question via the `AskUserQuestion` tool — do not skip:",
    "",
    "> Context at " + hit.pct + "% of " + hit.model + " window. Pick:",
    "> ",
    "> - `[a]` keep going (warn re-fires every +10 %)",
    "> - `[b]` `/clear` and resume now (Cairn writes the resume prompt)",
    "> - `[c]` mark task done (graduate the active TSK and start fresh)",
    "",
    `If the operator picks **\`b\`**, emit a code block containing exactly:\n\n\`\`\`\n/cairn-resume ${taskId}\n\`\`\`\n\nThe operator copies that, runs \`/clear\`, then pastes it into the fresh chat — Cairn rebuilds context from \`.cairn/tasks/active/${taskId}/journal.jsonl\`.`,
    "",
    "On `[c]`, call `cairn_task_complete({task_id, outcome: \"succeeded\"})` for the active task before ending the turn. On `[a]`, just continue.",
  ].join("\n");
}
