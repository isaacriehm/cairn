/**
 * `cairn_resume` — read the active task's journal + spec and emit a
 * resume payload that primes a fresh-context session cold.
 *
 * Called by the `/cairn:cairn-resume <task_id>` slash command after the
 * operator `/clear`s mid-task. SessionStart hook also calls this
 * automatically when it detects an active task whose journal has
 * entries from a prior session_id.
 *
 * The payload is structured so the slash-command body can render a
 * tight resume context block: title, goal, what's been done, what's
 * next, in-scope decisions/invariants. No Haiku call — pure read.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { resumeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";
import {
  findCurrentActiveTask,
  readTaskJournal,
  type JournalEntry,
} from "../../tasks/index.js";

interface Input {
  task_id?: string;
  /** Cap on most-recent journal entries returned. Default 7. */
  max_entries?: number;
}

interface SpecFrontmatter {
  title?: string;
  in_scope_decisions?: string[];
  in_scope_invariants?: string[];
  target_path_globs?: string[];
}

interface ResumePayload {
  ok: true;
  task_id: string;
  /** Where the task currently lives — `active` is the normal case;
   *  `done` means the task graduated between the resume prompt being
   *  rendered and the operator pasting the slash command. The slash
   *  command renders a "task already shipped" frame instead of the
   *  in-flight resume context. */
  scope: "active" | "done";
  /** ISO timestamp of completion when `scope === "done"`; null when
   *  the task is still active. */
  completed_at: string | null;
  title: string;
  goal: string;
  in_scope_decisions: string[];
  in_scope_invariants: string[];
  target_path_globs: string[];
  recent_entries: JournalEntry[];
  next_step: string | null;
  total_entries: number;
  /**
   * Deduplicated union of `files_touched` from the journal entries
   * returned in `recent_entries`. Lets the resume primer Read these
   * paths upfront so post-`/clear` Edit calls don't trip the "File
   * has not been read yet" wall (bug-mine report #10).
   */
  files_touched: string[];
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const taskId = input.task_id ?? findCurrentActiveTask(ctx.repoRoot);
  if (taskId === null) {
    return mcpError(
      "TASK_NOT_FOUND",
      "no active task to resume",
    );
  }

  const activeTaskDir = join(ctx.repoRoot, ".cairn", "tasks", "active", taskId);
  const doneTaskDir = join(ctx.repoRoot, ".cairn", "tasks", "done", taskId);
  let scope: "active" | "done";
  let taskDir: string;
  let completedAt: string | null = null;

  if (existsSync(activeTaskDir)) {
    scope = "active";
    taskDir = activeTaskDir;
  } else if (existsSync(doneTaskDir)) {
    // Race: task graduated between the Stop-hook resume prompt and the
    // operator pasting `/cairn:cairn-resume`. Surface the final journal frame
    // + completion timestamp instead of the cryptic "not found" error
    // so the operator sees what shipped.
    scope = "done";
    taskDir = doneTaskDir;
    completedAt = readCompletedAt(join(doneTaskDir, "status.yaml"));
  } else {
    return mcpError(
      "TASK_NOT_FOUND",
      `task directory missing in active/ and done/: ${taskId}`,
    );
  }

  const specPath = join(taskDir, "spec.tightened.md");
  let title = taskId;
  let goal = "(spec not found)";
  let inScopeDecisions: string[] = [];
  let inScopeInvariants: string[] = [];
  let targetPathGlobs: string[] = [];

  if (existsSync(specPath)) {
    const raw = readFileSync(specPath, "utf8");
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
      try {
        const fm = parseYaml(fmMatch[1] ?? "") as SpecFrontmatter;
        if (typeof fm.title === "string") title = fm.title;
        if (Array.isArray(fm.in_scope_decisions)) {
          inScopeDecisions = fm.in_scope_decisions.filter(
            (x): x is string => typeof x === "string",
          );
        }
        if (Array.isArray(fm.in_scope_invariants)) {
          inScopeInvariants = fm.in_scope_invariants.filter(
            (x): x is string => typeof x === "string",
          );
        }
        if (Array.isArray(fm.target_path_globs)) {
          targetPathGlobs = fm.target_path_globs.filter(
            (x): x is string => typeof x === "string",
          );
        }
      } catch {
        // malformed frontmatter — fall through with defaults
      }
      const body = fmMatch[2] ?? "";
      const goalMatch = body.match(/##\s+Goal\s*\r?\n+([\s\S]*?)(?:\r?\n##\s+|$)/);
      if (goalMatch && goalMatch[1] !== undefined) {
        goal = goalMatch[1].trim();
      }
    }
  }

  const journal = readTaskJournal(ctx.repoRoot, taskId, scope);
  const cap = Math.max(1, Math.min(50, input.max_entries ?? 7));
  const recent = journal.slice(-cap);
  const lastEntry = journal.length > 0 ? journal[journal.length - 1] : null;
  const nextStep = lastEntry?.next_step ?? null;

  // Union files_touched across recent entries, last write wins for order
  // (most recently touched first). Caller (cairn-resume primer) Reads
  // these upfront to prime the post-`/clear` session's Read cache.
  const seen = new Set<string>();
  const filesTouched: string[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i];
    const ft = entry?.files_touched;
    if (!Array.isArray(ft)) continue;
    for (const f of ft) {
      if (typeof f !== "string" || f.length === 0) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      filesTouched.push(f);
    }
  }

  const payload: ResumePayload = {
    ok: true,
    task_id: taskId,
    scope,
    completed_at: completedAt,
    title,
    goal,
    in_scope_decisions: inScopeDecisions,
    in_scope_invariants: inScopeInvariants,
    target_path_globs: targetPathGlobs,
    recent_entries: recent,
    next_step: nextStep,
    total_entries: journal.length,
    files_touched: filesTouched,
  };
  return payload;
}

function readCompletedAt(statusPath: string): string | null {
  if (!existsSync(statusPath)) return null;
  try {
    const raw = readFileSync(statusPath, "utf8");
    const parsed = parseYaml(raw) as { completed_at?: unknown } | null;
    if (parsed !== null && typeof parsed === "object") {
      const v = parsed.completed_at;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // fall through
  }
  return null;
}

export const resumeTool: ToolDef<Input> = {
  name: "cairn_resume",
  description:
    "Read the active task's journal + tightened spec and emit a resume payload (title, goal, in-scope DECs/INVs, last N journal entries, last-known next_step, deduplicated `files_touched` union across the returned entries). Used after `/clear` to rebuild operator context cold. The caller should Read the `files_touched` paths upfront so subsequent Edits don't trip Claude Code's per-session Read tracker. `task_id` defaults to the most-recently-touched active task.",
  inputSchema: resumeInput,
  handler,
};
