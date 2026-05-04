import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { isAppendAllowed, relPosix, safeJoin } from "../path-allowlist.js";
import { appendInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path: string;
  content: string;
  newline_separator?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const abs = safeJoin(ctx.repoRoot, input.path);
  if (typeof abs !== "string") return abs; // error envelope
  const rel = relPosix(ctx.repoRoot, abs);
  if (!isAppendAllowed(rel)) {
    return mcpError(
      "PATH_NOT_ALLOWED",
      `Append-write is not allowed for "${rel}". Allowlist limited to runs/active/<id>/{events,commands}.jsonl, staleness/log.jsonl, and inbox/**.`,
    );
  }
  // For runs/active/<id>/* paths, the run id segment must exist as a directory.
  const runMatch = rel.match(/^\.harness\/runs\/active\/([^/]+)\//);
  if (runMatch) {
    const runDir = `${ctx.repoRoot}/.harness/runs/active/${runMatch[1]}`;
    if (!existsSync(runDir)) {
      return mcpError("RUN_NOT_FOUND", `No active run dir at ${runDir}`);
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  const sep = input.newline_separator !== false ? "\n" : "";
  appendFileSync(abs, input.content + sep, "utf8");
  return { ok: true, path: rel, bytes_written: Buffer.byteLength(input.content + sep, "utf8") };
}

export const appendTool: ToolDef<Input> = {
  name: "harness_append",
  description:
    "Append-only write to a path-allowlisted file. No read required. Allowlist: runs/active/<id>/{events,commands}.jsonl, staleness/log.jsonl, inbox/**.",
  inputSchema: appendInput,
  handler,
};
