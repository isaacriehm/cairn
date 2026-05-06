/**
 * `cairn hook read-enrich` — PostToolUse hook on the Read tool.
 *
 * Scans the file content the agent just read for cairn citation
 * patterns (`§INV-NNNN`, `TODO(TSK-<id>)`, banned `DEC-<N>`) and prepends a
 * legend block via Claude Code's documented Shape-B `additionalContext`
 * field so the agent sees authoritative resolutions inline with the
 * file content. No MCP round-trip; all sources read directly from
 * `.cairn/` on disk.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md
 */

import { relative } from "node:path";
import { readHookStdin } from "../runners/payload.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { appendTrace } from "../../trace/index.js";
import { scanCitations } from "./citation-scanner.js";
import {
  getDecisionsLedger,
  getInvariantsLedger,
  getScopeIndexEntry,
  lookupTask,
  type TaskLookupResult,
} from "./ledger-cache.js";
import { buildLegend, type ScopeIndexHint } from "./legend-builder.js";

const MAX_CONTENT_BYTES = 512_000;
const BINARY_SAMPLE_BYTES = 1024;
const BINARY_THRESHOLD = 0.05;

interface ClaudePostToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  /**
   * Claude Code wraps the Read tool response as
   *   { type: "text", file: { filePath, content, numLines } }
   * but older / alternate shapes (`{ content }`, `{ text }`, `{ output }`)
   * also appear in some tool responses. `pickContent` walks all of them.
   */
  tool_response?: {
    content?: string;
    text?: string;
    output?: string;
    file?: { content?: string; text?: string; [key: string]: unknown };
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
  // Claude Code's Read tool wraps the body as `tool_response.file.content`.
  // Check the nested file shape FIRST so it wins over any same-named key
  // at the top level.
  if (resp.file !== undefined && typeof resp.file === "object" && resp.file !== null) {
    const f = resp.file;
    if (typeof f.content === "string" && f.content.length > 0) return f.content;
    if (typeof f.text === "string" && f.text.length > 0) return f.text;
  }
  const candidates = ["content", "text", "output"] as const;
  for (const k of candidates) {
    const v = resp[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function isBinary(content: string): boolean {
  const sampleLen = Math.min(content.length, BINARY_SAMPLE_BYTES);
  if (sampleLen === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = content.charCodeAt(i);
    if (code < 0x09 || (code >= 0x0e && code <= 0x1f)) suspicious++;
  }
  return suspicious / sampleLen > BINARY_THRESHOLD;
}

function isExcludedPath(relPath: string): boolean {
  if (relPath.startsWith(".archive/") || relPath === ".archive") return true;
  if (
    relPath.startsWith(".cairn/ground/") ||
    relPath === ".cairn/ground"
  ) {
    return true;
  }
  return false;
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

export async function runReadEnricher(): Promise<void> {
  const ts = new Date().toISOString();
  let outcome: Record<string, unknown> = { skip: "unknown" };
  let repoRootForTrace: string | null = null;
  let sessionForTrace: string | null = null;
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    sessionForTrace = typeof payload.session_id === "string" ? payload.session_id : null;

    if (payload.tool_name !== "Read") {
      outcome = { skip: "non-read-tool", tool_name: payload.tool_name };
      emitShapeB("");
      return;
    }
    const filePath =
      typeof payload.tool_input?.file_path === "string"
        ? payload.tool_input.file_path
        : undefined;
    const content = pickContent(payload.tool_response);
    if (filePath === undefined || content === undefined || content.length === 0) {
      outcome = {
        skip: "no-content",
        file_path: filePath ?? null,
        content_present: content !== undefined,
        content_chars: content?.length ?? 0,
      };
      emitShapeB("");
      return;
    }

    if (content.length > MAX_CONTENT_BYTES) {
      outcome = { skip: "content-too-large", content_chars: content.length };
      emitShapeB("");
      return;
    }

    const repoRoot = resolveRepoRoot(filePath);
    repoRootForTrace = repoRoot;
    if (repoRoot === null) {
      outcome = { skip: "no-cairn-ancestor", file_path: filePath };
      emitShapeB("");
      return;
    }

    const relPath = computeRelPath(repoRoot, filePath);
    if (isExcludedPath(relPath)) {
      outcome = { skip: "excluded-path", rel_path: relPath };
      emitShapeB("");
      return;
    }

    if (isBinary(content)) {
      outcome = { skip: "binary-content", rel_path: relPath };
      emitShapeB("");
      return;
    }

    const matches = scanCitations(content);
    const invariantsLedger = getInvariantsLedger(repoRoot);
    const decisionsLedger = getDecisionsLedger(repoRoot);
    const cachedEntry = getScopeIndexEntry(repoRoot, relPath);
    const scopeHint: ScopeIndexHint | null =
      cachedEntry !== null
        ? {
            decisions: cachedEntry.decisions,
            invariants: cachedEntry.invariants,
          }
        : null;
    const resolveTaskFn = (taskId: string): TaskLookupResult =>
      lookupTask(repoRoot, taskId);

    const legend = buildLegend(
      matches,
      invariantsLedger,
      decisionsLedger,
      scopeHint,
      resolveTaskFn,
    );
    if (legend === null) {
      outcome = {
        skip: "no-citations-no-scope",
        rel_path: relPath,
        decisions_matched: matches.decisions.length,
        invariants_matched: matches.invariants.length,
        todos_matched: matches.todos.length,
      };
      emitShapeB("");
      return;
    }
    outcome = {
      emitted: true,
      rel_path: relPath,
      legend_chars: legend.length,
      decisions_matched: matches.decisions.length,
      invariants_matched: matches.invariants.length,
      todos_matched: matches.todos.length,
    };
    emitShapeB(legend);
  } catch (err) {
    outcome = { error: err instanceof Error ? err.message : String(err) };
    // Defer-fail gracefully — the hook is a no-op enrichment, NOT a gate.
    try {
      emitShapeB("");
    } catch {
      // Last-resort: nothing we can do.
    }
  } finally {
    // Skip trace writes for non-cairn projects — keeps
    // ~/.local/cairn/trace/ quiet outside cairn-adopted repos so the
    // hook leaves no footprint when there's nothing to enrich.
    if (outcome["skip"] !== "no-cairn-ancestor") {
      appendTrace({
        ts,
        source: "hook",
        kind: "read-enrich",
        repo_root: repoRootForTrace,
        session_id: sessionForTrace,
        ok: outcome["error"] === undefined,
        payload: outcome,
      });
    }
  }
}
