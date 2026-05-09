/**
 * `cairn hook write-guard` — PostToolUse hook on the Write/Edit tool.
 *
 * Scans the just-written content for internal-only copy patterns
 * leaking into a user-facing surface (TODO/FIXME comments, cairn
 * citations, snake_case identifiers in display strings, internal repo
 * paths). Independent of the copy-safety glob, also looks up the
 * file's scope-index entry and renders a "decisions/invariants in
 * scope" reminder.
 *
 * Both sections are emitted via Claude Code's documented Shape-B
 * `additionalContext` field — the file on disk is NEVER modified, the
 * Write/Edit always succeeds. Guardian is a hint, not a gate.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md "Write Guardian" section.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readHookStdin } from "../runners/payload.js";
import { matchAnyGlob } from "../../ground/glob.js";
import { syncFileScopeFromContent } from "../../ground/scope-index.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import {
  readCopySafetyConfig,
  type CopySafetyConfig,
} from "./allowlist-reader.js";
import { scanForCopyLeakage, type CopyIssue } from "./copy-scanner.js";
import { getScopeIndexEntry } from "./ledger-cache.js";
import type { ScopeIndexHint } from "./legend-builder.js";

interface ClaudePostToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; new_string?: string };
  tool_response?: {
    content?: string;
    text?: string;
    output?: string;
    [key: string]: unknown;
  };
}

interface PostToolUseShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

interface PostToolUseBlockOutput {
  continue: false;
  decision: "block";
  reason: string;
}

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as ClaudePostToolUsePayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function pickContent(
  resp: ClaudePostToolUsePayload["tool_response"],
): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const candidates = ["content", "text", "output"] as const;
  for (const k of candidates) {
    const v = resp[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function computeRelPath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  if (rel.startsWith("..") || rel.length === 0) return filePath;
  return rel.replace(/\\/g, "/");
}

function emitShapeB(additionalContext: string): void {
  const out: PostToolUseShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function emitBlock(reason: string): void {
  const out: PostToolUseBlockOutput = {
    continue: false,
    decision: "block",
    reason,
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function filterAllowed(
  issues: CopyIssue[],
  config: CopySafetyConfig,
): CopyIssue[] {
  if (config.allowlist.length === 0) return issues;
  const allowed = new Set(config.allowlist);
  return issues.filter((i) => !allowed.has(i.match));
}

function renderCopySafetySection(
  fileName: string,
  issues: CopyIssue[],
): string {
  const lines: string[] = [];
  lines.push(
    `⚠ cairn:copy-safety — ${issues.length} potential internal copy issue(s) in ${fileName}:`,
  );
  for (const issue of issues) {
    lines.push(
      `  line ${issue.line}  "${issue.match}"  → ${issue.pattern} in user-facing string`,
    );
  }
  return lines.join("\n");
}

/**
 * Bypass detection defers to git: any file git would track is project
 * content (= the operator considers it part of the codebase, so a
 * mutation there should trace back to a tightened spec). Files git
 * ignores (build output, node_modules, lockfiles, generated code) are
 * skipped automatically — the project's own `.gitignore` is the
 * authority. The only universal exclusion is `.cairn/` itself
 * (cairn's state dir, which the agent legitimately writes during
 * adoption + attention flows without going through cairn-direction).
 *
 * `git check-ignore` exit codes:
 *   0  = path IS ignored (skip)
 *   1  = path NOT ignored (project content → bypass-eligible)
 *   128 = error / not in git repo (fail-safe to skip)
 */
function isProjectTrackedFile(repoRoot: string, relPath: string): boolean {
  if (relPath === ".cairn" || relPath.startsWith(".cairn/")) return false;
  const r = spawnSync("git", ["check-ignore", "-q", "--", relPath], {
    cwd: repoRoot,
  });
  return r.status === 1;
}

/**
 * Per-session sentinel that dedupes the bypass warning: first
 * untightened-edit fires + creates the file; subsequent edits in the
 * same session see the file and skip the warning section. Stop hook
 * scope reminder + copy-safety still emit normally.
 *
 * Cleared naturally when the session ends (`.cairn/sessions/<sid>/`
 * is removed by the SessionEnd hook). When `cairn-direction` later
 * writes `spec.tightened.md`, `hasTightenedActiveTask` returns true
 * and the bypass branch is skipped regardless of the sentinel.
 */
function bypassSentinelPath(
  repoRoot: string,
  sessionId: string | null,
): string | null {
  if (sessionId === null || sessionId.length === 0) return null;
  return join(repoRoot, ".cairn", "sessions", sessionId, "bypass-warned");
}

function bypassAlreadyWarned(
  repoRoot: string,
  sessionId: string | null,
): boolean {
  const p = bypassSentinelPath(repoRoot, sessionId);
  return p !== null && existsSync(p);
}

function markBypassWarned(
  repoRoot: string,
  sessionId: string | null,
): void {
  const p = bypassSentinelPath(repoRoot, sessionId);
  if (p === null) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, new Date().toISOString(), "utf8");
  } catch {
    // best-effort — warning loses dedupe but doesn't break the hook
  }
}

/**
 * `true` when `.cairn/tasks/active/` contains at least one task with
 * BOTH `spec.tightened.md` and `status.yaml` on disk. The pair is the
 * cairn-direction skill's contract — either both exist (tightening
 * landed) or neither does (skill never engaged for this work).
 */
function hasTightenedActiveTask(repoRoot: string): boolean {
  const tasksDir = join(repoRoot, ".cairn", "tasks", "active");
  if (!existsSync(tasksDir)) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(tasksDir, String(entry.name));
    if (
      existsSync(join(taskDir, "spec.tightened.md")) &&
      existsSync(join(taskDir, "status.yaml"))
    ) {
      return true;
    }
  }
  return false;
}

function renderBypassBlockReason(relPath: string): string {
  return [
    "BYPASS — Edit on tracked source rejected. No `.cairn/tasks/active/<id>/spec.tightened.md` exists.",
    "",
    `File: ${relPath}`,
    "",
    "Cairn's contract: every code change traces back to a tightened spec. The Edit landed on disk,",
    "but the cairn-direction skill never wrote a spec for this work — so the change is unattested.",
    "",
    "Recover NOW (before any further mutation):",
    "  1. `git -C <repoRoot> checkout -- " + relPath + "` to revert the unattested edit",
    "  2. Call the `cairn_task_create` MCP tool with the operator's original prompt as the `goal`",
    "     and a kebab `slug` (2-4 words). The server writes spec.tightened.md + status.yaml under",
    "     `.cairn/tasks/active/<task_id>/` with the correct format.",
    "  3. Re-apply the Edit; this hook will pass on next mutation.",
    "",
    "If the Edit is correct as-is and you simply forgot to tighten:",
    "  - Skip the revert; call `cairn_task_create` now to retroactively register the work.",
    "",
    "Subsequent edits in this session will not re-trigger this block (sentinel set).",
  ].join("\n");
}

function renderScopeSection(scopeHint: ScopeIndexHint): string {
  const lines: string[] = [];
  lines.push("ℹ cairn:scope — this file has rules in scope:");
  if (scopeHint.decisions.length > 0) {
    lines.push(`  decisions: ${scopeHint.decisions.join(", ")}`);
  }
  if (scopeHint.invariants.length > 0) {
    const formatted = scopeHint.invariants
      .map((v) => (v.startsWith("§") ? v : `§${v}`))
      .join(", ");
    lines.push(`  invariants: ${formatted}`);
  }
  return lines.join("\n");
}

export interface WriteGuardianResult {
  kind: "hint" | "block" | "none";
  message?: string;
}

export async function runWriteGuardian(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);

    const toolName = payload.tool_name;
    if (toolName !== "Write" && toolName !== "Edit") {
      emitShapeB("");
      return;
    }

    const filePath =
      typeof payload.tool_input?.file_path === "string"
        ? payload.tool_input.file_path
        : undefined;
    if (filePath === undefined) {
      emitShapeB("");
      return;
    }

    const repoRoot = resolveRepoRoot(filePath);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const result = await executeWriteGuardian(payload, repoRoot);
    if (result.kind === "block") {
      emitBlock(result.message ?? "blocked");
    } else {
      emitShapeB(result.message ?? "");
    }
  } catch {
    emitShapeB("");
  }
}

export async function executeWriteGuardian(
  payload: ClaudePostToolUsePayload,
  repoRoot: string,
): Promise<WriteGuardianResult> {
  const toolName = payload.tool_name;
  const filePath =
    typeof payload.tool_input?.file_path === "string"
      ? payload.tool_input.file_path
      : undefined;

  if (filePath === undefined) return { kind: "none" };

  let content = pickContent(payload.tool_response);
  if (
    (content === undefined || content.length === 0) &&
    toolName === "Edit"
  ) {
    const ns = payload.tool_input?.new_string;
    if (typeof ns === "string" && ns.length > 0) content = ns;
  }
  if (content === undefined || content.length === 0) return { kind: "none" };

  const relPath = computeRelPath(repoRoot, filePath);
  const config = readCopySafetyConfig(repoRoot);
  const inGlobs =
    config.enabled && matchAnyGlob(relPath, config.globs);

  let issues: CopyIssue[] = [];
  if (inGlobs) {
    const raw = scanForCopyLeakage(content, filePath);
    issues = filterAllowed(raw, config);
  }

  // Deterministic scope-index sync
  try {
    syncFileScopeFromContent(repoRoot, relPath, content);
  } catch {
    // ignore
  }

  const cachedEntry = getScopeIndexEntry(repoRoot, relPath);
  const scopeHint: ScopeIndexHint | null =
    cachedEntry !== null &&
    (cachedEntry.decisions.length > 0 || cachedEntry.invariants.length > 0)
      ? {
          decisions: cachedEntry.decisions,
          invariants: cachedEntry.invariants,
        }
      : null;

  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : null;

  // Bypass detection
  if (
    isProjectTrackedFile(repoRoot, relPath) &&
    !hasTightenedActiveTask(repoRoot) &&
    !bypassAlreadyWarned(repoRoot, sessionId)
  ) {
    markBypassWarned(repoRoot, sessionId);
    return { kind: "block", message: renderBypassBlockReason(relPath) };
  }

  const sections: string[] = [];
  if (issues.length > 0) {
    sections.push(renderCopySafetySection(basename(filePath), issues));
  }
  if (scopeHint !== null) {
    sections.push(renderScopeSection(scopeHint));
  }

  if (sections.length === 0) return { kind: "none" };

  const block =
    sections.join("\n\n") + "\n\nWrite succeeded. Review before committing.";
  return { kind: "hint", message: block };
}
