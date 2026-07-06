/**
 * Cursor vs Claude Code hook platform detection and stdout emitters.
 *
 * Cursor docs: https://cursor.com/docs/hooks
 * - sessionStart / postToolUse: `{ additional_context }` (+ optional `env`)
 * - stop: `{ followup_message }`
 *
 * Claude Code: Shape-B `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 */

let forceCursor = false;

/** Set by `cairn hook … --cursor` before runners execute. */
export function setCursorHookMode(enabled: boolean): void {
  forceCursor = enabled;
}

/** True when running under the Cursor Agent plugin hook host. */
export function isCursorHook(): boolean {
  if (forceCursor) return true;
  const root = process.env["CURSOR_PLUGIN_ROOT"];
  return typeof root === "string" && root.length > 0;
}

/** True when only Cursor plugin root is set (no Claude plugin root). */
export function isCursorOnlyHook(): boolean {
  const claude = process.env["CLAUDE_PLUGIN_ROOT"];
  const cursor = process.env["CURSOR_PLUGIN_ROOT"];
  return (
    isCursorHook() &&
    (typeof claude !== "string" || claude.length === 0) &&
    typeof cursor === "string" &&
    cursor.length > 0
  );
}

function writeStdout(payload: unknown): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function writeStdoutNoExit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** postToolUse stdout JSON (no exit) — for runners that fall through. */
export function writePostToolUseOutput(context: string): void {
  if (isCursorHook()) {
    writeStdoutNoExit(context.length > 0 ? { additional_context: context } : {});
    return;
  }
  writeStdoutNoExit({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  });
}

/** postToolUse block stdout JSON (no exit). */
export function writePostToolUseBlock(reason: string): void {
  if (isCursorHook()) {
    writeStdoutNoExit(reason.length > 0 ? { additional_context: reason } : {});
    return;
  }
  writeStdoutNoExit({
    continue: false,
    decision: "block",
    reason,
  });
}

/** sessionStart — Cursor `{ env?, additional_context? }`. */
export function emitCursorSessionStart(
  context: string,
  env?: Record<string, string>,
): never {
  const out: Record<string, unknown> = {};
  if (env !== undefined && Object.keys(env).length > 0) {
    out["env"] = env;
  }
  if (context.length > 0) {
    out["additional_context"] = context;
  }
  writeStdout(out);
}

/** postToolUse — Cursor `{ additional_context? }` or Claude Shape-B (exits). */
export function emitPostToolUseOutput(context: string): never {
  writePostToolUseOutput(context);
  process.exit(0);
}

/**
 * postToolUse write-guard block — Claude `{ continue:false, decision:block }`;
 * Cursor has no postToolUse deny; inject as additional_context instead.
 */
export function emitPostToolUseBlock(reason: string): never {
  writePostToolUseBlock(reason);
  process.exit(0);
}

/**
 * stop — Cursor `{ followup_message? }`; Claude `{ decision:block, reason }` or `{ continue:true }`.
 *
 * Cursor only consumes `followup_message` when `status === "completed"` and
 * `loop_count` is below the script's `loop_limit` (default 5).
 */
export function emitStopOutput(opts: {
  reason: string;
  systemMessage?: string;
  status?: string;
  loop_count?: number;
  loop_limit?: number | null;
}): never {
  const { reason, systemMessage, status, loop_count, loop_limit = 5 } = opts;
  if (isCursorHook()) {
    const canFollowup =
      status === "completed" &&
      (loop_limit === null ||
        loop_count === undefined ||
        loop_count < loop_limit);
    if (canFollowup) {
      const followup =
        reason.length > 0
          ? systemMessage !== undefined && systemMessage.length > 0
            ? `${reason}\n\n${systemMessage}`
            : reason
          : systemMessage ?? "";
      if (followup.length > 0) {
        writeStdout({ followup_message: followup });
      }
    }
    writeStdout({});
  }
  if (reason.length > 0) {
    writeStdout({
      decision: "block",
      reason,
      ...(systemMessage !== undefined && systemMessage.length > 0
        ? { systemMessage }
        : {}),
    });
  }
  writeStdout({
    continue: true,
    ...(systemMessage !== undefined && systemMessage.length > 0
      ? { systemMessage }
      : {}),
  });
}
