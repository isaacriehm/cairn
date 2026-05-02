import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpContext } from "../context.js";
import { recordDriftEvent } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { isArchiveDenied, relPosix, safeJoin } from "../path-allowlist.js";
import { archiveInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path: string;
  reason: string;
  archive_dir?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const abs = safeJoin(ctx.repoRoot, input.path);
  if (typeof abs !== "string") return abs;
  const rel = relPosix(ctx.repoRoot, abs);
  if (isArchiveDenied(rel)) {
    return mcpError(
      "NOT_ALLOWED",
      `Path "${rel}" is in the archive-deny list (sacred ground: AGENTS.md, .claude/**, decisions/, brand/).`,
    );
  }
  if (rel.startsWith(".archive/")) {
    return { ok: true, idempotent: true, path: rel, note: "Already in .archive/" };
  }
  if (!existsSync(abs)) {
    return mcpError("FILE_NOT_FOUND", `No file at ${rel}`);
  }
  if (!statSync(abs).isFile()) {
    return mcpError("NOT_ALLOWED", `Path is not a file: ${rel}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const bucket = input.archive_dir ?? today;
  const target = join(ctx.repoRoot, ".archive", bucket, rel);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(abs, target);
  recordDriftEvent(ctx.repoRoot, {
    ts: new Date().toISOString(),
    kind: "orphan_path",
    path: rel,
    detail: `archived: ${input.reason}`,
    severity: "soft",
  });
  return {
    ok: true,
    archived_from: rel,
    archived_to: relPosix(ctx.repoRoot, target),
    reason: input.reason,
  };
}

export const archiveTool: ToolDef<Input> = {
  name: "harness_archive",
  description:
    "Move a canonical-zone file to .archive/<archive_dir or today>/<original_path>. Idempotent. Records a staleness/log.jsonl event. Refuses sacred paths (AGENTS.md, .claude/**, decisions/, brand/).",
  inputSchema: archiveInput,
  handler,
};
