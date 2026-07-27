import { z } from "zod";
import { ModelRunnerError } from "../error.js";
import type {
  BuildModelInvocation,
  DecodedModelOutput,
} from "./types.js";

const ClaudeEnvelopeSchema = z.object({
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).optional(),
}).passthrough();

const MODELS = {
  fast: "haiku",
  capable: "sonnet",
} as const;

function decodeClaude(stdout: string): DecodedModelOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (cause) {
    throw new ModelRunnerError({
      message: `claude output was not JSON: ${stdout.slice(0, 200)}`,
      provider: "claude",
      kind: "invalid_output",
      cause,
    });
  }
  const result = ClaudeEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new ModelRunnerError({
      message: `claude output envelope was invalid: ${stdout.slice(0, 200)}`,
      provider: "claude",
      kind: "invalid_output",
      cause: result.error,
    });
  }
  const env = result.data;
  const usage = env.usage === undefined
    ? undefined
    : {
        input_tokens: env.usage.input_tokens,
        output_tokens: env.usage.output_tokens,
        ...(env.usage.cache_creation_input_tokens === undefined
          ? {}
          : { cache_creation_input_tokens: env.usage.cache_creation_input_tokens }),
        ...(env.usage.cache_read_input_tokens === undefined
          ? {}
          : { cache_read_input_tokens: env.usage.cache_read_input_tokens }),
      };
  return {
    text: env.result ?? "",
    ...(env.structured_output === undefined ? {} : { parsed: env.structured_output }),
    envelope: raw as Record<string, unknown>,
    ...(usage === undefined ? {} : { usage }),
  };
}

export const buildClaudeInvocation: BuildModelInvocation = ({
  command,
  cwd,
  tier,
  options,
}) => {
  const model = MODELS[tier];
  const args = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    model,
  ];
  if (options.system !== undefined) {
    args.push("--system-prompt", options.system);
  }
  if (options.jsonSchema !== undefined) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.isolateAmbientContext === true) {
    args.push(
      "--setting-sources",
      "project,local",
      "--tools",
      "",
      "--disable-slash-commands",
    );
  }
  return {
    provider: "claude",
    model,
    command,
    args,
    stdin: options.prompt,
    cwd,
    cleanup() {},
    decode: decodeClaude,
  };
};
