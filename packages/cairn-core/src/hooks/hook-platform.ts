/**
 * Claude Code, Cursor, and Codex hook platform detection and stdout emitters.
 *
 * Cursor docs: https://cursor.com/docs/hooks
 * - sessionStart / postToolUse: `{ additional_context }` (+ optional `env`)
 * - stop: `{ followup_message }`
 *
 * Claude Code: Shape-B `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 */

export const AGENT_HOSTS = ["claude-code", "cursor", "codex"] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export type HookResult =
  | { kind: "continue"; context?: string; message?: string }
  | { kind: "block"; reason: string }
  | { kind: "follow-up"; prompt: string }
  | { kind: "environment"; env: Record<string, string>; context?: string };

export interface StopInput {
  status?: "completed" | "aborted" | "error";
  continuationCount?: number;
  continuationLimit?: number | null;
}

export interface HookRunOptions {
  host?: AgentHost;
}

export function resolveAgentHost(explicit?: string): AgentHost {
  if ((AGENT_HOSTS as readonly string[]).includes(explicit ?? "")) {
    return explicit as AgentHost;
  }
  if (process.env["CURSOR_PLUGIN_ROOT"]) return "cursor";
  if (process.env["PLUGIN_ROOT"] && !process.env["CLAUDE_PLUGIN_ROOT"]) return "codex";
  return "claude-code";
}

function contextOf(result: HookResult): string {
  if (result.kind === "continue" || result.kind === "environment") {
    return result.context ?? "";
  }
  if (result.kind === "block") return result.reason;
  return result.prompt;
}

function shapeB(event: "SessionStart" | "PostToolUse", context: string): unknown {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context,
    },
  };
}

export function serializeSessionStart(host: AgentHost, result: HookResult): unknown {
  const context = contextOf(result);
  if (host === "cursor") {
    const payload: Record<string, unknown> = {};
    if (result.kind === "environment" && Object.keys(result.env).length > 0) {
      payload["env"] = result.env;
    }
    if (context.length > 0) payload["additional_context"] = context;
    return payload;
  }
  return shapeB("SessionStart", context);
}

export function serializePostToolUse(host: AgentHost, result: HookResult): unknown {
  if (result.kind === "block") {
    if (host === "cursor") return { additional_context: result.reason };
    if (host === "codex") return { continue: false, stopReason: result.reason };
    return { continue: false, decision: "block", reason: result.reason };
  }
  const context = contextOf(result);
  if (host === "cursor") {
    return context.length > 0 ? { additional_context: context } : {};
  }
  return shapeB("PostToolUse", context);
}

export function serializeStop(
  host: AgentHost,
  result: HookResult,
  input: StopInput = {},
): unknown {
  if (host === "cursor") {
    if (result.kind !== "follow-up") return {};
    const limit = input.continuationLimit ?? 5;
    const canContinue =
      input.status === "completed" &&
      (input.continuationLimit === null ||
        input.continuationCount === undefined ||
        input.continuationCount < limit);
    return canContinue ? { followup_message: result.prompt } : {};
  }
  if (result.kind === "follow-up") {
    return { decision: "block", reason: result.prompt };
  }
  if (result.kind === "block") {
    return { decision: "block", reason: result.reason };
  }
  const message =
    result.kind === "continue"
      ? result.message
      : result.kind === "environment"
        ? undefined
        : undefined;
  return {
    continue: true,
    ...(message !== undefined && message.length > 0 ? { systemMessage: message } : {}),
  };
}

export function buildStopResult(
  host: AgentHost,
  opts: { reason: string; systemMessage?: string },
): HookResult {
  const { reason, systemMessage } = opts;
  if (reason.length > 0) {
    const prompt =
      systemMessage !== undefined && systemMessage.length > 0
        ? `${reason}\n\n${systemMessage}`
        : reason;
    return { kind: "follow-up", prompt };
  }
  if (systemMessage !== undefined && systemMessage.length > 0) {
    return host === "cursor"
      ? { kind: "follow-up", prompt: systemMessage }
      : { kind: "continue", message: systemMessage };
  }
  return { kind: "continue" };
}

function writeStdout(payload: unknown): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function writeStdoutNoExit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** sessionStart stdout JSON (exits). */
export function emitSessionStartOutput(
  host: AgentHost,
  context: string,
  env?: Record<string, string>,
): never {
  const result: HookResult =
    env !== undefined
      ? { kind: "environment", env, context }
      : { kind: "continue", context };
  writeStdout(serializeSessionStart(host, result));
}

/** postToolUse stdout JSON (no exit) — for runners that fall through. */
export function writePostToolUseOutput(host: AgentHost, context: string): void {
  writeStdoutNoExit(serializePostToolUse(host, { kind: "continue", context }));
}

/** postToolUse block stdout JSON (no exit). */
export function writePostToolUseBlock(host: AgentHost, reason: string): void {
  writeStdoutNoExit(serializePostToolUse(host, { kind: "block", reason }));
}

/** postToolUse stdout JSON (exits). */
export function emitPostToolUseOutput(host: AgentHost, context: string): never {
  writePostToolUseOutput(host, context);
  process.exit(0);
}

/** stop stdout JSON (exits). */
export function emitStopOutput(host: AgentHost, opts: {
  reason: string;
  systemMessage?: string;
  status?: string;
  loop_count?: number;
  loop_limit?: number | null;
}): never {
  const { reason, systemMessage, status, loop_count, loop_limit = 5 } = opts;
  const result = buildStopResult(host, {
    reason,
    ...(systemMessage !== undefined ? { systemMessage } : {}),
  });
  writeStdout(
    serializeStop(host, result, {
      ...(status === "completed" || status === "aborted" || status === "error"
        ? { status }
        : {}),
      ...(loop_count !== undefined ? { continuationCount: loop_count } : {}),
      continuationLimit: loop_limit,
    }),
  );
}
