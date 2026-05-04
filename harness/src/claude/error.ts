/**
 * Claude subprocess error classification.
 *
 * The CLI surfaces rate-limit / overload / auth failures via stderr +
 * non-zero exit. Classifying lets the orchestrator distinguish:
 *   - `rate_limit` / `overloaded` → pause dispatch after N consecutive,
 *     don't burn the operator's coding-plan quota on doomed retries
 *   - `auth` → stop trying immediately + page operator
 *   - `other` → ordinary failure, dispatch normally
 *
 * Used by both `claude/runner.ts` (one-shot calls) and
 * `orchestrator/runner.ts` (stream-json implementer runs).
 */

export type ClaudeErrorKind =
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "other";

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly exitCode: number | undefined;
  readonly stderr: string | undefined;

  constructor(args: {
    message: string;
    kind: ClaudeErrorKind;
    exitCode?: number | null;
    stderr?: string;
  }) {
    super(args.message);
    this.name = "ClaudeError";
    this.kind = args.kind;
    this.exitCode =
      typeof args.exitCode === "number" ? args.exitCode : undefined;
    this.stderr = args.stderr;
  }
}

const RATE_LIMIT_RE = /rate[\s_-]?limit|\b429\b|too many requests|usage_limit/i;
const OVERLOADED_RE = /overloaded|\b529\b|temporarily unavailable|service.?unavailable|\b503\b/i;
const AUTH_RE =
  /unauthorized|forbidden|\b401\b|\b403\b|authentication|please[\s_-]+log[\s_-]?in|not[\s_-]+authenticated|invalid[\s_-]+api[\s_-]+key|api[\s_-]+key[\s_-]+expired|credit[\s_-]+balance[\s_-]+is[\s_-]+too[\s_-]+low/i;

export function classifyClaudeError(args: {
  message: string;
  exitCode?: number | null;
  stderr?: string;
}): ClaudeErrorKind {
  const text = `${args.message}\n${args.stderr ?? ""}`;
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  if (OVERLOADED_RE.test(text)) return "overloaded";
  if (AUTH_RE.test(text)) return "auth";
  return "other";
}

/** True when the kind warrants a dispatch pause (vs a per-task fail). */
export function isQuotaKind(kind: ClaudeErrorKind): boolean {
  return kind === "rate_limit" || kind === "overloaded";
}

export function asClaudeError(err: unknown, fallbackStderr?: string): ClaudeError {
  if (err instanceof ClaudeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const kind = classifyClaudeError({
    message,
    ...(fallbackStderr !== undefined ? { stderr: fallbackStderr } : {}),
  });
  return new ClaudeError({
    message,
    kind,
    ...(fallbackStderr !== undefined ? { stderr: fallbackStderr } : {}),
  });
}
