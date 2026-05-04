import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpContext } from "../context.js";
import { writeInvalidationEvent, type InvalidationEventRef } from "../../events/index.js";
import { recordDriftEvent } from "../../ground/index.js";
import { withWriteLock } from "../../lock.js";
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
  return withWriteLock(ctx.repoRoot, () => {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(abs, target);
    recordDriftEvent(ctx.repoRoot, {
      ts: new Date().toISOString(),
      kind: "orphan_path",
      path: rel,
      detail: `archived: ${input.reason}`,
      severity: "soft",
    });

    try {
      const refs: InvalidationEventRef[] = [{ kind: "path", id: rel }];
      const decMatch = rel.match(/^\.harness\/ground\/decisions\/(?:_inbox\/)?(DEC-\d+)/);
      if (decMatch) refs.unshift({ kind: "decision", id: decMatch[1]! });
      writeInvalidationEvent(ctx.repoRoot, {
        kind: "path_archived",
        refs,
        path: rel,
        source: { session_id: ctx.sessionId ?? null, tool: "harness_archive" },
      });
    } catch {
      // Event emission must never roll back the rename.
    }

    return {
      ok: true,
      archived_from: rel,
      archived_to: relPosix(ctx.repoRoot, target),
      reason: input.reason,
    };
  });
}

export const archiveTool: ToolDef<Input> = {
  name: "harness_archive",
  description:
    "Move a canonical-zone file to .archive/<archive_dir or today>/<original_path>. Idempotent. Records a staleness/log.jsonl event. Refuses sacred paths (AGENTS.md, .claude/**, decisions/, brand/).",
  inputSchema: archiveInput,
  handler,
};
