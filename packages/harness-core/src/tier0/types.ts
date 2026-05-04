/**
 * Tier-0 classifier contract. Per docs/PLUGIN_ARCHITECTURE.md §14: Haiku
 * (escalating to Sonnet for complex prompts) via the Claude binary
 * subprocess. Falls back to a deterministic regex matcher if the Claude
 * binary is unavailable so smoke tests + scripted callers stay green.
 * Production flows assume the Claude binary is present.
 */

export type Tier0Intent =
  | "code_task"
  | "review"
  | "direction"
  | "question"
  | "halt"
  | "status"
  | "unknown";

export interface ClassificationResult {
  intent: Tier0Intent;
  confidence: number;
  source: "claude" | "fallback";
}

export interface Tier0RegexFallback {
  (text: string): { intent: Tier0Intent; confidence: number };
}

export interface Tier0ClassifyOptions {
  timeoutMs?: number;
  /** Used when the Claude binary is unreachable or returns malformed output. */
  regexFallback?: Tier0RegexFallback;
}
