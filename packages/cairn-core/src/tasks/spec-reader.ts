/**
 * Shared `spec.tightened.md` frontmatter + `## Goal` reader.
 *
 * Factored out of `cairn_resume` (mcp/tools/resume.ts) so both the
 * resume payload AND the UserPromptSubmit working-header (context
 * engine, stage 1) read the spec the same way — one parse, no drift.
 * The parse is verbatim from the original resume.ts implementation.
 *
 * Returns null when the task has no `spec.tightened.md` yet (e.g. a
 * task still in `queued`/`tightening`). Malformed frontmatter degrades
 * to defaults rather than throwing — callers run inside hooks that must
 * never crash the agent loop.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface SpecFrontmatter {
  title?: string;
  in_scope_decisions?: string[];
  in_scope_invariants?: string[];
  target_path_globs?: string[];
}

export interface TaskSpec {
  title: string;
  goal: string;
  inScopeDecisions: string[];
  inScopeInvariants: string[];
  targetPathGlobs: string[];
}

/**
 * Read `<taskDir>/spec.tightened.md`'s frontmatter (`title`,
 * `in_scope_decisions[]`, `in_scope_invariants[]`, `target_path_globs[]`)
 * and the body's `## Goal` section. `taskDir` is the absolute task
 * directory (active or done). Returns null when the spec file is absent.
 */
export function readTaskSpec(taskDir: string): TaskSpec | null {
  const specPath = join(taskDir, "spec.tightened.md");
  if (!existsSync(specPath)) return null;

  let title = "";
  let goal = "";
  let inScopeDecisions: string[] = [];
  let inScopeInvariants: string[] = [];
  let targetPathGlobs: string[] = [];

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

  return { title, goal, inScopeDecisions, inScopeInvariants, targetPathGlobs };
}
