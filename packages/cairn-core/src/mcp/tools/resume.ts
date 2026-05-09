/**
 * `cairn_resume` — read the active task's journal + spec and emit a
 * resume payload that primes a fresh-context session cold.
 *
 * Called by the `/cairn-resume <task_id>` slash command after the
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
  title: string;
  goal: string;
  in_scope_decisions: string[];
  in_scope_invariants: string[];
  target_path_globs: string[];
  recent_entries: JournalEntry[];
  next_step: string | null;
  total_entries: number;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const taskId = input.task_id ?? findCurrentActiveTask(ctx.repoRoot);
  if (taskId === null) {
    return mcpError(
      "TASK_NOT_FOUND",
      "no active task to resume",
    );
  }

  const taskDir = join(ctx.repoRoot, ".cairn", "tasks", "active", taskId);
  if (!existsSync(taskDir)) {
    return mcpError(
      "TASK_NOT_FOUND",
      `active task directory missing: .cairn/tasks/active/${taskId}/`,
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

  const journal = readTaskJournal(ctx.repoRoot, taskId, "active");
  const cap = Math.max(1, Math.min(50, input.max_entries ?? 7));
  const recent = journal.slice(-cap);
  const lastEntry = journal.length > 0 ? journal[journal.length - 1] : null;
  const nextStep = lastEntry?.next_step ?? null;

  const payload: ResumePayload = {
    ok: true,
    task_id: taskId,
    title,
    goal,
    in_scope_decisions: inScopeDecisions,
    in_scope_invariants: inScopeInvariants,
    target_path_globs: targetPathGlobs,
    recent_entries: recent,
    next_step: nextStep,
    total_entries: journal.length,
  };
  return payload;
}

export const resumeTool: ToolDef<Input> = {
  name: "cairn_resume",
  description:
    "Read the active task's journal + tightened spec and emit a resume payload (title, goal, in-scope DECs/INVs, last N journal entries, last-known next_step). Used after `/clear` to rebuild operator context cold. `task_id` defaults to the most-recently-touched active task.",
  inputSchema: resumeInput,
  handler,
};
