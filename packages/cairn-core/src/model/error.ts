import type { ModelProvider } from "./types.js";

export type ModelRunnerErrorKind =
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "timeout"
  | "unavailable"
  | "invalid_output"
  | "other";

export class ModelRunnerError extends Error {
  readonly provider: ModelProvider | null;
  readonly kind: ModelRunnerErrorKind;
  readonly exitCode: number | undefined;
  readonly stderr: string | undefined;

  constructor(args: {
    message: string;
    provider: ModelProvider | null;
    kind: ModelRunnerErrorKind;
    exitCode?: number | null;
    stderr?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = "ModelRunnerError";
    this.provider = args.provider;
    this.kind = args.kind;
    this.exitCode =
      typeof args.exitCode === "number" ? args.exitCode : undefined;
    this.stderr = args.stderr;
  }
}

const RATE_LIMIT_RE = /rate[\s_-]?limit|\b429\b|too many requests|usage_limit|usage limit/i;
const OVERLOADED_RE =
  /overloaded|\b529\b|temporarily unavailable|service.?unavailable|\b503\b/i;
const AUTH_RE =
  /unauthorized|forbidden|\b401\b|\b403\b|authentication|please[\s_-]+log[\s_-]?in|not[\s_-]+authenticated|invalid[\s_-]+api[\s_-]+key|api[\s_-]+key[\s_-]+expired|credit[\s_-]+balance[\s_-]+is[\s_-]+too[\s_-]+low/i;
const UNAVAILABLE_RE =
  /\bENOENT\b|command not found|not recognized as an internal or external command|executable.*not found/i;

export function classifyModelError(args: {
  message: string;
  exitCode?: number | null;
  stderr?: string;
}): ModelRunnerErrorKind {
  if (args.exitCode === 143) return "timeout";
  const text = `${args.message}\n${args.stderr ?? ""}`;
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  if (OVERLOADED_RE.test(text)) return "overloaded";
  if (AUTH_RE.test(text)) return "auth";
  if (UNAVAILABLE_RE.test(text)) return "unavailable";
  return "other";
}

export function isQuotaKind(kind: ModelRunnerErrorKind): boolean {
  return kind === "rate_limit" || kind === "overloaded";
}

export function asModelRunnerError(
  err: unknown,
  provider: ModelProvider | null,
  fallbackStderr?: string,
): ModelRunnerError {
  if (err instanceof ModelRunnerError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const kind = classifyModelError({
    message,
    ...(fallbackStderr === undefined ? {} : { stderr: fallbackStderr }),
  });
  return new ModelRunnerError({
    message,
    provider,
    kind,
    ...(fallbackStderr === undefined ? {} : { stderr: fallbackStderr }),
    cause: err,
  });
}
