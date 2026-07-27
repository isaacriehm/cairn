/**
 * Provider-neutral subprocess contract for Cairn's bounded model-assisted
 * work. Providers authenticate through their installed agent CLI.
 */

export const MODEL_PROVIDERS = ["claude", "codex", "cursor"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Semantic work tiers. Provider transports own the concrete model mapping. */
export type ModelTier = "fast" | "capable";

export interface RunModelOptions {
  tier: ModelTier;
  /** User prompt, delivered through stdin without a shell. */
  prompt: string;
  /** Higher-priority task rules when the provider exposes such a surface. */
  system?: string;
  /** JSON Schema enforced natively when possible and always validated locally. */
  jsonSchema?: object;
  /** Explicit provider override. No silent fallback when supplied. */
  provider?: ModelProvider;
  /** Working directory for non-isolated calls. */
  cwd?: string;
  /** Hard timeout in milliseconds. Default: 120000. */
  timeoutMs?: number;
  /** Free-form trace tag such as `init.mapper`. */
  purpose?: string;
  /** Trace and cache context. */
  repoRoot?: string;
  sessionId?: string;
  /** Cache deterministic responses under `.cairn/cache/model`. */
  cacheable?: boolean;
  /** Run away from project/user instruction files where the CLI permits. */
  isolateAmbientContext?: boolean;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RunModelResult {
  text: string;
  parsed?: unknown;
  durationMs: number;
  provider: ModelProvider;
  tier: ModelTier;
  model: string;
  envelope?: Record<string, unknown>;
  usage?: ModelUsage;
  cached: boolean;
}
