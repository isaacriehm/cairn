/**
 * `cairn hook write-guard` — PostToolUse hook on the Write/Edit tool.
 *
 * Scans the just-written content for internal-only copy patterns
 * leaking into a user-facing surface (TODO/FIXME comments, cairn
 * citations, snake_case keys in CamelCase schemas). Blocks with a
 * warning/hint in Shape-B `additionalContext`.
 *
 * This hook is critical for maintaining "ground state" integrity:
 *   1. Safety — prevent internal technical debt leaking to users.
 *   2. Context — remind the agent about in-scope decisions for the file.
 *   3. Bootstrap — suggest `cairn init` if a write lands in a project
 *      the agent should adopt but hasn't yet.
 *
 * Spec: docs/WRITE_GUARDIAN_SPEC.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve, dirname, join } from "node:path";
import { z } from "zod";
import {
  getScopeIndexEntry,
  matchAnyGlob,
} from "@isaacriehm/cairn-state";
import {
  readHookStdin,
  parseHookPayload,
  emitShapeB,
  appendTelemetry,
} from "../runners/payload.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { readCopySafetyConfig } from "./allowlist-reader.js";
import { scanForCopyLeakage } from "./copy-scanner.js";
import type { CopyIssue } from "./copy-scanner.js";
import { buildLegend, type ScopeIndexHint } from "./legend-builder.js";
import { logger } from "../../logger.js";

const ClaudePostToolUsePayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.object({
    file_path: z.string().optional(),
    new_string: z.string().optional(),
  }).passthrough().optional(),
  tool_response: z.object({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudePostToolUsePayload = z.infer<typeof ClaudePostToolUsePayloadSchema>;

const log = logger("hooks.post-tool-use.write-guardian");

export interface GuardianResult {
  kind: "none" | "block" | "hint";
  message?: string;
}

/**
 * Hook entry point.
 */
export async function runWriteGuardian(): Promise<void> {
  const ts = new Date().toISOString();
  let outcome: Record<string, unknown> = { skip: "unknown" };
  let repoRootForTrace: string | null = null;
  let sessionForTrace: string | null = null;
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    sessionForTrace = payload.session_id ?? null;

    if (payload.tool_name !== "Write" && payload.tool_name !== "Edit") {
      outcome = { skip: "non-write-tool", tool_name: payload.tool_name };
      emitShapeB("", "PostToolUse");
      return;
    }

    const filePath = payload.tool_input?.file_path;
    const content = pickContent(payload.tool_response);
    if (filePath === undefined || content === undefined || content.length === 0) {
      outcome = {
        skip: "no-content",
        file_path: filePath ?? null,
        content_present: content !== undefined,
      };
      emitShapeB("", "PostToolUse");
      return;
    }

    const cwd = payload.cwd ?? process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    repoRootForTrace = repoRoot;
    if (repoRoot === null) {
      outcome = { skip: "not-adopted", cwd };
      emitShapeB("", "PostToolUse");
      return;
    }

    const relPath = relative(repoRoot, resolve(cwd, filePath));
    const result = executeWriteGuardian({
      repoRoot,
      relPath,
      content,
      payload,
    });

    outcome = {
      ok: true,
      path: relPath,
      guardian_kind: result.kind,
      message_chars: result.message?.length ?? 0,
    };

    if (result.kind === "none") {
      emitShapeB("", "PostToolUse");
    } else {
      emitShapeB(result.message ?? "", "PostToolUse");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = { error: message };
    log.error({ err: message }, "write-guardian hook failed");
    emitShapeB("", "PostToolUse");
  } finally {
    if (repoRootForTrace !== null) {
      appendTelemetry({
        repoRoot: repoRootForTrace,
        sessionId: sessionForTrace,
        kind: "write-guardian",
        durationMs: Date.now() - Date.parse(ts),
        source: "hook",
        warnings: [],
        extra: outcome,
      });
    }
  }
}

export function executeWriteGuardian(args: {
  repoRoot: string;
  relPath: string;
  content: string;
  payload: ClaudePostToolUsePayload;
}): GuardianResult {
  const { repoRoot, relPath, content, payload } = args;
  const filePath = relPath;

  const copyConfig = readCopySafetyConfig(repoRoot);
  const shouldScanCopy =
    copyConfig.enabled && matchAnyGlob(relPath, copyConfig.globs);
  let issues: ReturnType<typeof scanForCopyLeakage> = [];
  if (shouldScanCopy) {
    const raw = scanForCopyLeakage(content, filePath);
    const allowlist = new Set(copyConfig.allowlist);
    issues = raw.filter((i) => !allowlist.has(i.match));
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

  const sessionId = payload.session_id ?? null;

  const sections: string[] = [];

  // Bypass detection — emit a once-per-session hint instead of blocking.
  // Blocking interrupts the agent's flow and the "retry the write"
  // recovery path is fragile (LLM often interprets the stop as abort
  // and drops the work). The reminder still surfaces via Shape-B
  // additionalContext so the operator sees it and can choose to wrap
  // future writes in a cairn-direction task; the write itself proceeds.
  if (
    isProjectTrackedFile(repoRoot, relPath) &&
    !hasTightenedActiveTask(repoRoot) &&
    !bypassAlreadyWarned(repoRoot, sessionId)
  ) {
    markBypassWarned(repoRoot, sessionId);
    sections.push(renderBypassHintSection(relPath));
  }

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

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = ClaudePostToolUsePayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function pickContent(
  resp: ClaudePostToolUsePayload["tool_response"],
): string | undefined {
  if (resp === undefined) return undefined;
  
  if (typeof resp.content === "string" && resp.content.length > 0) return resp.content;
  if (typeof resp.text === "string" && resp.text.length > 0) return resp.text;
  if (typeof resp.output === "string" && resp.output.length > 0) return resp.output;

  return undefined;
}

function renderCopySafetySection(filename: string, issues: CopyIssue[]): string {
  const lines: string[] = [];
  lines.push(`## Copy safety — ${filename}`);
  lines.push("");
  for (const i of issues) {
    lines.push(`- ${i.pattern}: ${i.match} (line ${i.line})`);
  }
  return lines.join("\n");
}

function renderScopeSection(hint: ScopeIndexHint): string {
  const lines: string[] = [];
  lines.push("## In-scope decisions/invariants for this file");
  lines.push("");
  for (const d of hint.decisions) {
    lines.push(`- §${d}`);
  }
  for (const i of hint.invariants) {
    lines.push(`- §${i}`);
  }
  return lines.join("\n");
}

function renderBypassHintSection(relPath: string): string {
  return (
    `## Cairn — write without active task\n\n` +
    `\`${relPath}\` is a tracked source file but no cairn-direction task ` +
    `is active. For non-trivial changes, call \`cairn_task_create\` first ` +
    `so the spec is captured before edits land. Trivial edits + explicit ` +
    `bypasses are fine — this reminder only fires once per session.`
  );
}

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync } from "node:fs";

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
    if (existsSync(join(tasksDir, entry.name, "spec.tightened.md"))) return true;
  }
  return false;
}

function isProjectTrackedFile(repoRoot: string, relPath: string): boolean {
  if (relPath === ".cairn" || relPath.startsWith(".cairn/")) return false;
  const r = spawnSync("git", ["check-ignore", "-q", "--", relPath], {
    cwd: repoRoot,
  });
  return r.status === 1;
}

function bypassAlreadyWarned(repoRoot: string, sessionId: string | null): boolean {
  if (sessionId === null) return false;
  const path = join(repoRoot, ".cairn", "cache", `bypass-warned-${sessionId}`);
  return existsSync(path);
}

function markBypassWarned(repoRoot: string, sessionId: string | null): void {
  if (sessionId === null) return;
  const path = join(repoRoot, ".cairn", "cache", `bypass-warned-${sessionId}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "true", "utf8");
}
