/**
 * Subprocess wrapper for the `claude` CLI.
 *
 * Per WORKFLOW_GUIDE §2.2 budget metric (operator answer T1): every Tier-1/2/3 LLM call goes through the
 * operator's Claude Code coding-plan subscription via `claude --print
 * --model <tier> --output-format json`. No direct Anthropic SDK calls.
 *
 * Tier mapping is hardcoded (no env vars per operator profile). The CLI's
 * model alias resolution maps `haiku|sonnet|opus` to the latest model id
 * for that family — we don't pin specific snapshots here so the wrapper
 * keeps tracking newer models as Anthropic ships them.
 */

export type ClaudeTier = "haiku" | "sonnet" | "opus";

export interface RunClaudeOptions {
  tier: ClaudeTier;
  /** User prompt — sent on stdin so it can be arbitrary length. */
  prompt: string;
  /** Optional system prompt override (replaces default Claude Code system). */
  system?: string;
  /**
   * Optional JSON Schema for structured output. When provided, the CLI
   * enforces the shape and the wrapper parses + returns under `parsed`.
   */
  jsonSchema?: object;
  /** Working directory for the subprocess. Default = process.cwd(). */
  cwd?: string;
  /** Hard timeout in ms. Default 120000. */
  timeoutMs?: number;
  /**
   * Extra CLI flags. Useful for `--add-dir`, `--disable-slash-commands`,
   * etc. when the caller knows what they want.
   */
  extraArgs?: string[];
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RunClaudeResult {
  text: string;
  /** Parsed JSON when `jsonSchema` was set. */
  parsed?: unknown;
  durationMs: number;
  tier: ClaudeTier;
  model: string;
  /** Raw JSON envelope from `--output-format json`. */
  envelope?: Record<string, unknown>;
  /** Usage stats lifted from the envelope when present. */
  usage?: ClaudeUsage;
}
