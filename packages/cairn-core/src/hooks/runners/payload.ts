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

export const CAIRN_HOOK_VERSION = "0.2.0";

const ClaudeHookPayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  source: z.string().optional(),
}).passthrough();

export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>;

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

/**
 * Write Cursor's `sessionStart` output format and exit.
 * Cursor expects `{ "additional_context": "..." }` at the top level
 * (snake_case, no `hookSpecificOutput` envelope).
 */
export function emitCursorContext(context: string): never {
  process.stdout.write(JSON.stringify({ additional_context: context }));
  process.exit(0);
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
