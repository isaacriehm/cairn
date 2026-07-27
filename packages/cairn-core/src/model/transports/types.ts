import type {
  ModelProvider,
  ModelTier,
  ModelUsage,
  RunModelOptions,
} from "../types.js";

export interface DecodedModelOutput {
  text: string;
  parsed?: unknown;
  envelope?: Record<string, unknown>;
  usage?: ModelUsage;
}

export interface ModelInvocation {
  provider: ModelProvider;
  model: string;
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  cleanup(): void;
  decode(stdout: string): DecodedModelOutput;
}

export interface BuildInvocationArgs {
  command: string;
  cwd: string;
  tier: ModelTier;
  options: RunModelOptions;
}

export type BuildModelInvocation = (
  args: BuildInvocationArgs,
) => ModelInvocation;
