/**
 * Shared utilities for Claude Code hook runners — stdin reader,
 * payload parser, Shape-B emitter, telemetry sink.
 *
 * Spec: Claude Code hook contract (Shape-B JSON on stdout).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const HARNESS_HOOK_VERSION = "0.0.0";

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

export function readHookStdin(): Promise<string> {
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
      // No piped input — Claude Code always pipes; this only matters in
      // dev/test invocations.
      resolveP("");
    }
  });
}

export function parseHookPayload(text: string): ClaudeHookPayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as ClaudeHookPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function emitShapeB(output: object): void {
  process.stdout.write(JSON.stringify(output));
  process.stdout.write("\n");
}

export interface HookTelemetryRow {
  hook: string;
  repoRoot: string | null;
  sessionId: string | null;
  source: string | null;
  durationMs: number;
  warnings: string[];
  /** Free-form fields merged into the telemetry row. */
  extra?: Record<string, unknown>;
}

/**
 * Append a telemetry row to `~/.local/harness/state/<hook>.jsonl`.
 * Telemetry must never throw — failures are swallowed.
 */
export function recordHookTelemetry(row: HookTelemetryRow): void {
  try {
    const dir = resolve(homedir(), ".local", "harness", "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `${row.hook}.jsonl`);
    const body = {
      ts: new Date().toISOString(),
      hook_version: HARNESS_HOOK_VERSION,
      hook: row.hook,
      ...(row.sessionId !== null ? { session_id: row.sessionId } : {}),
      ...(row.source !== null ? { source: row.source } : {}),
      ...(row.repoRoot !== null ? { repo_root: row.repoRoot } : {}),
      duration_ms: row.durationMs,
      warnings: row.warnings,
      ...(row.extra ?? {}),
    };
    appendFileSync(path, `${JSON.stringify(body)}\n`, "utf8");
  } catch {
    // Telemetry must never block the hook.
  }
}
