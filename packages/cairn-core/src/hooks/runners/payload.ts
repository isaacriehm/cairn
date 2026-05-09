/**
 * Shared utilities for Claude Code hook runners — stdin reader,
 * payload parser, Shape-B emitter, telemetry sink.
 *
 * Spec: Claude Code hook contract (Shape-B JSON on stdout).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

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
 * Write Shape-B JSON to stdout and exit.
 * Claude Code expects exactly this JSON on stdout to continue.
 */
export function emitShapeB(context: string): never {
  const payload = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse", // matches Claude's generic expectation
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(payload));
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
  const dir = join(row.repoRoot, ".cairn", "state", "telemetry");
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
