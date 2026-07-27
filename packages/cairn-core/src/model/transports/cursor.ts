import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRunnerError } from "../error.js";
import type {
  BuildModelInvocation,
  DecodedModelOutput,
} from "./types.js";

const CursorEnvelopeSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string(),
  duration_ms: z.number().optional(),
  session_id: z.string().optional(),
  request_id: z.string().optional(),
}).passthrough();

function buildCursorPrompt(options: {
  prompt: string;
  system?: string;
  jsonSchema?: object;
}): string {
  const parts = [
    "Do not use tools, run commands, or modify files. Answer only from the supplied instructions and input.",
  ];
  if (options.system !== undefined) {
    parts.push(`System instructions:\n${options.system}`);
  }
  parts.push(`Task:\n${options.prompt}`);
  if (options.jsonSchema !== undefined) {
    parts.push(
      "Return only JSON matching this schema, with no Markdown fence or surrounding prose:\n" +
        JSON.stringify(options.jsonSchema),
    );
  }
  return parts.join("\n\n");
}

function decodeCursor(stdout: string): DecodedModelOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (cause) {
    throw new ModelRunnerError({
      message: `cursor output was not JSON: ${stdout.slice(0, 200)}`,
      provider: "cursor",
      kind: "invalid_output",
      cause,
    });
  }
  const result = CursorEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new ModelRunnerError({
      message: `cursor output envelope was invalid: ${stdout.slice(0, 200)}`,
      provider: "cursor",
      kind: "invalid_output",
      cause: result.error,
    });
  }
  return {
    text: result.data.result,
    envelope: raw as Record<string, unknown>,
  };
}

export const buildCursorInvocation: BuildModelInvocation = ({
  command,
  cwd,
  options,
}) => {
  const configDir = join(cwd, ".cursor");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "cli.json"),
    JSON.stringify({
      permissions: {
        allow: [],
        deny: [
          "Shell(*)",
          "Read(**)",
          "Read(/**)",
          "Write(**)",
          "Write(/**)",
        ],
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    provider: "cursor",
    model: "auto",
    command,
    args: ["--print", "--output-format", "json", "--model", "auto"],
    stdin: buildCursorPrompt(options),
    cwd,
    cleanup() {},
    decode: decodeCursor,
  };
};
