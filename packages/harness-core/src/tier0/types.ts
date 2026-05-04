/**
 * Tier-0 classifier contract. Per L14 + L38: solo-dev cost-zero classification
 * via Ollama. Falls back to a regex matcher when Ollama is unreachable so
 * smoke tests + adapter pipelines stay green.
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
  source: "ollama" | "regex_fallback";
}

export interface Tier0RegexFallback {
  (text: string): { intent: Tier0Intent; confidence: number };
}

export interface Tier0ClassifyOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
  /** Used when Ollama is unreachable or returns malformed output. */
  regexFallback?: Tier0RegexFallback;
}
