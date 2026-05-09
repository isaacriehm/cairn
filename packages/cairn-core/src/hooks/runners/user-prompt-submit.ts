/**
 * `cairn hook user-prompt-submit` — UserPromptSubmit hook.
 *
 * Claude Code's `@<path>` shorthand attaches file content to the
 * prompt directly, BYPASSING the Read tool — so the
 * PostToolUse(Read) read-enricher hook never fires for those files.
 * This hook fills the gap: it parses `@<path>` patterns from the
 * raw prompt, reads each file, scans for §INV-/§DEC-/TODO(TSK-)
 * citations, builds the same legend the read-enricher would have,
 * and emits it as `additionalContext`. Result: the model sees
 * the resolved citations alongside the attached file content,
 * matching the documented "bare symbols always resolve on Read"
 * contract regardless of attachment path.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveRepoRoot } from "../../session-start/index.js";
import { scanCitations, type ScannedCitations } from "../post-tool-use/citation-scanner.js";
import {
  getDecisionsLedger,
  getInvariantsLedger,
  getScopeIndexEntry,
  lookupTask,
  type TaskLookupResult,
} from "@isaacriehm/cairn-state";
import { buildLegend, type ScopeIndexHint } from "../post-tool-use/legend-builder.js";
import { readHookStdin } from "./payload.js";

const MAX_FILE_BYTES = 512_000;
// Match `@<path>` only when `@` follows whitespace or is at start of
// prompt — filters out emails, twitter-style mentions, etc. Path
// chars: word, dot, slash, hyphen.
import { z } from "zod";

const AT_PATH_RE = /(?:^|\s)@([\w./-]+)/g;

const UserPromptSubmitPayloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  prompt: z.string().optional(),
}).passthrough();

type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;

interface UserPromptSubmitShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

function parsePayload(text: string): UserPromptSubmitPayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as UserPromptSubmitPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function emitShapeB(additionalContext: string): void {
  const out: UserPromptSubmitShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function extractAttachedPaths(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(AT_PATH_RE)) {
    const p = m[1];
    if (typeof p === "string" && p.length > 0) out.push(p);
  }
  return out;
}

function safeRead(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    const buf = readFileSync(absPath, "utf8");
    if (buf.length > MAX_FILE_BYTES) return buf.slice(0, MAX_FILE_BYTES);
    return buf;
  } catch {
    return null;
  }
}

export async function runUserPromptSubmitHook(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

    // Fast-path: no `@` token in prompt → no work.
    if (prompt.length === 0 || !prompt.includes("@")) {
      emitShapeB("");
      return;
    }

    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const paths = extractAttachedPaths(prompt);
    if (paths.length === 0) {
      emitShapeB("");
      return;
    }

    // Aggregate citations across all attached files. Filter to existing
    // files — non-existent `@`-mentions are typically not file refs.
    const aggregated: ScannedCitations = {
      invariants: [],
      todos: [],
      decisions: [],
    };
    let firstHitRel: string | null = null;
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : resolve(repoRoot, p);
      const content = safeRead(abs);
      if (content === null) continue;
      const matches = scanCitations(content);
      const hit =
        matches.invariants.length > 0 ||
        matches.todos.length > 0 ||
        matches.decisions.length > 0;
      if (!hit) continue;
      if (firstHitRel === null) {
        const rel = relative(repoRoot, abs);
        if (!rel.startsWith("..") && rel.length > 0) {
          firstHitRel = rel.replace(/\\/g, "/");
        }
      }
      aggregated.invariants.push(...matches.invariants);
      aggregated.todos.push(...matches.todos);
      aggregated.decisions.push(...matches.decisions);
    }

    if (
      aggregated.invariants.length === 0 &&
      aggregated.todos.length === 0 &&
      aggregated.decisions.length === 0
    ) {
      emitShapeB("");
      return;
    }

    const cachedEntry =
      firstHitRel !== null ? getScopeIndexEntry(repoRoot, firstHitRel) : null;
    const scopeHint: ScopeIndexHint | null =
      cachedEntry !== null
        ? {
            decisions: cachedEntry.decisions,
            invariants: cachedEntry.invariants,
          }
        : null;

    const invariantsLedger = getInvariantsLedger(repoRoot);
    const decisionsLedger = getDecisionsLedger(repoRoot);
    const resolveTaskFn = (taskId: string): TaskLookupResult =>
      lookupTask(repoRoot, taskId);

    const legend = buildLegend(
      aggregated,
      invariantsLedger,
      decisionsLedger,
      scopeHint,
      resolveTaskFn,
    );

    emitShapeB(legend ?? "");
  } catch {
    try {
      emitShapeB("");
    } catch {
      // last resort
    }
  }
}
