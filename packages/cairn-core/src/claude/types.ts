/**
 * Subprocess wrapper for the `claude` CLI.
 *
 * Every LLM call goes through the operator's Claude Code coding-plan
 * subscription via `claude --print --model <tier> --output-format json`.
 * No direct Anthropic SDK calls.
 *
 * Tier mapping is hardcoded (no env vars). The CLI's model alias resolution
 * maps `haiku|sonnet|opus` to the latest model for that family.
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
  /**
   * Free-form purpose tag (e.g. "init.mapper", "init.docs-ingest",
   * "init.source-comments") for trace logs. Helps the operator find
   * which call surface emitted a given subprocess invocation.
   */
  purpose?: string;
  /** Repo root + Claude Code session id for trace correlation, when known. */
  repoRoot?: string;
  sessionId?: string;
  /**
   * When true AND `repoRoot` is set, look up + persist responses in
   * `.cairn/cache/haiku/<sha256>.json`. Cache key is the full input
   * fingerprint (tier|system|prompt|jsonSchema). Only meaningful for
   * idempotent classification calls — never enable for mapper or any
   * call whose answer depends on filesystem state at run time.
   */
  cacheable?: boolean;
  /**
   * When true, the subprocess runs from `os.tmpdir()` and passes
   * `--setting-sources project,local --tools "" --disable-slash-commands`
   * so the call inherits NO ambient context: no user-global
   * `~/.claude/CLAUDE.md`, no parent-dir CLAUDE.md hierarchy, no MCP
   * tools, no plugin slash commands. Caller-supplied prompt + system
   * prompt are the entire input.
   *
   * Required for Cairn's haiku-tier classifications to prevent
   * operator's personal / organizational context (org name, ethos
   * statements, identifying memory) from leaking into project
   * artifacts (brand text, DEC drafts, classifications).
   *
   * Reduces input-token cost ~95% (76k → ~700 tokens observed) on
   * top of the privacy fix.
   */
  isolateAmbientContext?: boolean;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
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
