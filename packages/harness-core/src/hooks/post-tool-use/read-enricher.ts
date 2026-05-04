/**
 * `harness hook read-enrich` — PostToolUse hook on the Read tool.
 *
 * Scans the file content the agent just read for harness citation
 * patterns (`§V<N>`, `TODO(TSK-<id>)`, banned `DEC-<N>`) and prepends a
 * legend block via Claude Code's documented Shape-B `additionalContext`
 * field so the agent sees authoritative resolutions inline with the
 * file content. No MCP round-trip; all sources read directly from
 * `.harness/` on disk.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md
 */

import { relative } from "node:path";
import { resolveRepoRoot } from "../../session-start/index.js";
import { scanCitations } from "./citation-scanner.js";
import {
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

function readStdin(): Promise<string> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolveP(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      resolveP("");
    });
    if (process.stdin.isTTY) {
      resolveP("");
    }
  });
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
    relPath.startsWith(".harness/ground/") ||
    relPath === ".harness/ground"
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
  try {
    const raw = await readStdin();
    const payload = parsePayload(raw);

    if (payload.tool_name !== "Read") {
      emitShapeB("");
      return;
    }
    const filePath =
      typeof payload.tool_input?.file_path === "string"
        ? payload.tool_input.file_path
        : undefined;
    const content = pickContent(payload.tool_response);
    if (filePath === undefined || content === undefined || content.length === 0) {
      emitShapeB("");
      return;
    }

    if (content.length > MAX_CONTENT_BYTES) {
      emitShapeB("");
      return;
    }

    const repoRoot = resolveRepoRoot(filePath);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const relPath = computeRelPath(repoRoot, filePath);
    if (isExcludedPath(relPath)) {
      emitShapeB("");
      return;
    }

    if (isBinary(content)) {
      emitShapeB("");
      return;
    }

    const matches = scanCitations(content);
    const ledger = getInvariantsLedger(repoRoot);
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

    const legend = buildLegend(matches, ledger, scopeHint, resolveTaskFn);
    if (legend === null) {
      emitShapeB("");
      return;
    }
    emitShapeB(legend);
  } catch {
    // Defer-fail gracefully — the hook is a no-op enrichment, NOT a gate.
    try {
      emitShapeB("");
    } catch {
      // Last-resort: nothing we can do.
    }
  }
}
