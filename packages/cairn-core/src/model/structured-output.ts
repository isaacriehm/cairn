import { fromJSONSchema } from "zod";
import { ModelRunnerError } from "./error.js";
import type { ModelProvider } from "./types.js";

const JSON_FENCE_RE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i;

function parseJsonText(text: string, provider: ModelProvider): unknown {
  const fenced = JSON_FENCE_RE.exec(text);
  const candidate = fenced?.[1] ?? text;
  try {
    return JSON.parse(candidate);
  } catch (cause) {
    throw new ModelRunnerError({
      message: `${provider} final response did not contain valid JSON`,
      provider,
      kind: "invalid_output",
      cause,
    });
  }
}

export function parseAndValidateStructuredOutput(args: {
  provider: ModelProvider;
  text: string;
  nativeParsed?: unknown;
  schema: object;
}): unknown {
  const value =
    args.nativeParsed === undefined
      ? parseJsonText(args.text, args.provider)
      : args.nativeParsed;
  let validator: ReturnType<typeof fromJSONSchema>;
  try {
    validator = fromJSONSchema(
      args.schema as Parameters<typeof fromJSONSchema>[0],
    );
  } catch (cause) {
    throw new ModelRunnerError({
      message: "Cairn received an invalid JSON Schema from its model call site",
      provider: args.provider,
      kind: "invalid_output",
      cause,
    });
  }
  const result = validator.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ModelRunnerError({
      message: `${args.provider} structured response failed schema validation: ${detail}`,
      provider: args.provider,
      kind: "invalid_output",
    });
  }
  return result.data;
}
