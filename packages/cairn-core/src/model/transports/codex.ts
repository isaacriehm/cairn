import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRunnerError } from "../error.js";
import type {
  BuildModelInvocation,
  DecodedModelOutput,
} from "./types.js";

const CODEX_MODEL = "gpt-5.3-codex-spark";

function decodeCodex(stdout: string): DecodedModelOutput {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new ModelRunnerError({
      message: "codex returned an empty final message",
      provider: "codex",
      kind: "invalid_output",
    });
  }
  return { text };
}

export const buildCodexInvocation: BuildModelInvocation = ({
  command,
  cwd,
  options,
}) => {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--model",
    CODEX_MODEL,
  ];
  if (options.system !== undefined) {
    args.push(
      "-c",
      `developer_instructions=${JSON.stringify(options.system)}`,
    );
  }

  let schemaDir: string | null = null;
  if (options.jsonSchema !== undefined) {
    schemaDir = mkdtempSync(join(tmpdir(), "cairn-codex-schema-"));
    const schemaPath = join(schemaDir, "output-schema.json");
    try {
      writeFileSync(schemaPath, JSON.stringify(options.jsonSchema), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (err) {
      rmSync(schemaDir, { recursive: true, force: true });
      schemaDir = null;
      throw err;
    }
    args.push("--output-schema", schemaPath);
  }
  args.push("-");

  return {
    provider: "codex",
    model: CODEX_MODEL,
    command,
    args,
    stdin: options.prompt,
    cwd,
    cleanup() {
      if (schemaDir !== null) {
        rmSync(schemaDir, { recursive: true, force: true });
        schemaDir = null;
      }
    },
    decode: decodeCodex,
  };
};
