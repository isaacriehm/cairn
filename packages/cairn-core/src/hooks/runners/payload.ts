/**
 * Shared utilities for Claude Code hook runners — stdin reader,
 * payload parser, Shape-B emitter, telemetry sink.
 *
 * Spec: Claude Code hook contract (Shape-B JSON on stdout).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { cairnDir } from "@isaacriehm/cairn-state";
import { emitCursorSessionStart } from "../hook-platform.js";

export const CAIRN_HOOK_VERSION = "0.2.0";

const ClaudeHookPayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  source: z.string().optional(),
  /** Cursor sessionStart / postToolUse — workspace folder roots. */
  workspace_roots: z.array(z.string()).optional(),
  /** Cursor stop — agent loop status. */
  status: z.enum(["completed", "aborted", "error"]).optional(),
  /** Cursor stop / subagentStop — prior follow-up iterations. */
  loop_count: z.number().optional(),
}).passthrough();

export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>;

/**
 * Resolve the adopted-project cwd for hook runners.
 * Cursor injects CURSOR_PROJECT_DIR on every hook; sessionStart also
 * carries workspace_roots when cwd is absent.
 */
export function resolveHookCwd(payload: ClaudeHookPayload): string {
  if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  const projectDir =
    process.env["CURSOR_PROJECT_DIR"] ?? process.env["CLAUDE_PROJECT_DIR"];
  if (typeof projectDir === "string" && projectDir.length > 0) {
    return projectDir;
  }
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0) {
    const first = roots[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return process.cwd();
}

export function readHookStdin(): Promise<string> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolveP(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function parseHookPayload(text: string): ClaudeHookPayload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = ClaudeHookPayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/** Cursor postToolUse aliases → Claude Code tool names. */
const CURSOR_TOOL_ALIASES: Record<string, string> = {
  StrReplace: "Edit",
};

export type PostToolInput = {
  file_path?: string;
  content?: string;
  new_string?: string;
  old_string?: string;
  [key: string]: unknown;
};

export type PostToolResponse = {
  content?: string;
  text?: string;
  output?: string;
  file?: { content?: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export interface NormalizedPostToolUsePayload extends ClaudeHookPayload {
  tool_name?: string;
  tool_input?: PostToolInput;
  tool_response?: PostToolResponse;
}

function mapCursorFields(obj: Record<string, unknown>): void {
  if (typeof obj["path"] === "string" && obj["file_path"] === undefined) {
    obj["file_path"] = obj["path"];
  }
  if (typeof obj["contents"] === "string" && obj["content"] === undefined) {
    obj["content"] = obj["contents"];
  }
}

/**
 * Normalize Cursor postToolUse payloads to the Claude Code field names
 * hook runners expect. Parses `tool_output` JSON into `tool_response`,
 * maps `path`→`file_path` and `contents`→`content`, and aliases
 * StrReplace→Edit.
 */
export function normalizePostToolUse(raw: ClaudeHookPayload): NormalizedPostToolUsePayload {
  const payload = { ...raw } as NormalizedPostToolUsePayload;

  if (typeof payload.tool_name === "string") {
    const mapped = CURSOR_TOOL_ALIASES[payload.tool_name];
    if (mapped !== undefined) payload.tool_name = mapped;
  }

  if (payload.tool_input !== undefined && typeof payload.tool_input === "object") {
    const ti = { ...(payload.tool_input as Record<string, unknown>) };
    mapCursorFields(ti);
    payload.tool_input = ti as PostToolInput;
  }

  const rawRecord = raw as Record<string, unknown>;
  const toolOutput = rawRecord["tool_output"];
  if (typeof toolOutput === "string" && toolOutput.length > 0) {
    try {
      const parsed = JSON.parse(toolOutput) as Record<string, unknown>;
      mapCursorFields(parsed);
      if (
        typeof parsed["file"] === "object" &&
        parsed["file"] !== null &&
        parsed["content"] === undefined
      ) {
        const f = parsed["file"] as Record<string, unknown>;
        if (typeof f["content"] === "string") parsed["content"] = f["content"];
        if (typeof f["text"] === "string" && parsed["content"] === undefined) {
          parsed["content"] = f["text"];
        }
      }
      payload.tool_response = parsed as PostToolResponse;
      const ti = { ...(payload.tool_input ?? {}) } as Record<string, unknown>;
      if (ti["file_path"] === undefined) {
        if (typeof parsed["file_path"] === "string") ti["file_path"] = parsed["file_path"];
        else if (typeof parsed["path"] === "string") ti["file_path"] = parsed["path"];
      }
      if (Object.keys(ti).length > 0) {
        payload.tool_input = ti as PostToolInput;
      }
    } catch {
      payload.tool_response = { content: toolOutput };
    }
  } else if (
    payload.tool_response === undefined &&
    typeof rawRecord["tool_response"] === "object" &&
    rawRecord["tool_response"] !== null
  ) {
    const resp = { ...(rawRecord["tool_response"] as Record<string, unknown>) };
    mapCursorFields(resp);
    payload.tool_response = resp as PostToolResponse;
  }

  return payload;
}

/**
 * Body that landed on disk: Write carries `content`, Edit/StrReplace
 * carries `new_string`. Read from `tool_input` — `tool_response` is
 * often a status string, not the file body.
 */
export function pickWrittenContent(
  toolName: string | undefined,
  input: PostToolInput | undefined,
): string | undefined {
  if (input === undefined) return undefined;
  if (toolName === "Write") {
    return typeof input.content === "string" ? input.content : undefined;
  }
  if (typeof input.new_string === "string") return input.new_string;
  if (typeof input.content === "string") return input.content;
  return undefined;
}

/** Extract readable text from a postToolUse tool_response object. */
export function pickToolResponseContent(
  resp: PostToolResponse | undefined,
): string | undefined {
  if (resp === undefined) return undefined;
  if (resp.file !== undefined) {
    const f = resp.file;
    if (typeof f.content === "string" && f.content.length > 0) return f.content;
    if (typeof f.text === "string" && f.text.length > 0) return f.text;
  }
  if (typeof resp.content === "string" && resp.content.length > 0) return resp.content;
  if (typeof resp.text === "string" && resp.text.length > 0) return resp.text;
  if (typeof resp.output === "string" && resp.output.length > 0) return resp.output;
  return undefined;
}

/**
 * Hook event names Claude Code validates against the runner's stdout
 * `hookSpecificOutput.hookEventName` field. Claude Code 2.1+ rejects
 * a hook payload whose `hookEventName` doesn't match the event the
 * hook was invoked for — e.g. a SessionStart hook returning
 * `"PostToolUse"` is dropped with `Hook returned incorrect event
 * name`. The previous shared default of `"PostToolUse"` worked
 * historically but is now wrong for every other event.
 */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostToolUse"
  | "PreToolUse"
  | "Notification";

/**
 * Write Shape-B JSON to stdout and exit.
 * Claude Code expects exactly this JSON on stdout to continue.
 * `hookEventName` MUST match the hook event the runner was invoked
 * for; mismatches are rejected as `Hook returned incorrect event
 * name` in Claude Code 2.1+.
 *
 * `Stop`, `SessionEnd`, and `PreCompact` reject `hookSpecificOutput`
 * entirely under Claude Code 2.1+ — those runners must call
 * `emitContinue` instead.
 */
export function emitShapeB(context: string, hookEventName: HookEventName): never {
  const payload = {
    continue: true,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

/** Write Cursor sessionStart output and exit. */
export function emitCursorContext(context: string): never {
  emitCursorSessionStart(context);
}

/**
 * Write a bare `{continue: true}` payload and exit. Use for hook
 * events that Claude Code 2.1+ refuses with a `hookSpecificOutput`
 * envelope (currently `Stop`, `SessionEnd`, and `PreCompact`).
 */
export function emitContinue(): never {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

/** Truncated append-only telemetry sink. */
export function appendTelemetry(row: {
  repoRoot: string;
  sessionId: string | null;
  kind: string;
  durationMs: number;
  source: string | null;
  warnings: string[];
  extra?: Record<string, unknown>;
}): void {
  const dir = cairnDir(row.repoRoot, "state", "telemetry");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
  }
  const path = join(dir, "hooks.jsonl");
  const entry = {
    ts: new Date().toISOString(),
    kind: row.kind,
    repo_root: row.repoRoot,
    session_id: row.sessionId,
    duration_ms: row.durationMs,
    payload: {
      ...(row.source !== null ? { source: row.source } : {}),
      warnings: row.warnings,
      ...(row.extra ?? {}),
    },
  };
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}
