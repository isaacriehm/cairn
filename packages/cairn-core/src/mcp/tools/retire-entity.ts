/**
 * `cairn_retire_decision` / `cairn_retire_invariant` — the manual OUT
 * verb for the ground ledger.
 *
 * Retirement = archive, never hard-delete: the entity moves to
 * `.cairn/ground/.archive/`, drops from the active ledger + SoT cache.
 * A lingering
 * `§DEC-/§INV-` cite degrades to an `orphaned_citation` GC finding
 * rather than a dangling reference.
 *
 * This is also the shared apply primitive the entity-orphan autonomous
 * path and the cairn-attention "retire" action both invoke — one place
 * decides what archival means.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  archiveEntity,
  decisionsDir,
  invariantsDir,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { withWriteLock } from "../../lock.js";
import { retireDecisionInput, retireInvariantInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
  reason?: string;
}

function makeHandler(kind: "DEC" | "INV") {
  return async (ctx: McpContext, input: Input): Promise<unknown> => {
    const block = requireBootstrap(ctx.repoRoot);
    if (block !== null) return block;
    const dir =
      kind === "INV" ? invariantsDir(ctx.repoRoot) : decisionsDir(ctx.repoRoot);
    const abs = join(dir, `${input.id}.md`);
    if (!existsSync(abs)) {
      return mcpError(
        kind === "INV" ? "INVARIANT_NOT_FOUND" : "DECISION_NOT_FOUND",
        `${input.id} is not in the active ledger (already retired, or never existed)`,
      );
    }
    return withWriteLock(ctx.repoRoot, async () => {
      const res = archiveEntity({
        repoRoot: ctx.repoRoot,
        id: input.id,
        reason: input.reason ?? "manual retire via cairn_retire",
      });
      if (!res.ok) {
        return mcpError(
          "RETIRE_FAILED",
          `failed to retire ${input.id}: ${res.error ?? "unknown error"}`,
        );
      }
      return {
        ok: true,
        id: res.id,
        kind: res.kind,
        archived_path: res.archivedPath,
      };
    });
  };
}

export const retireDecisionTool: ToolDef<Input> = {
  name: "cairn_retire_decision",
  description:
    "Retire (archive) an accepted DEC that has rotted — superseded in spirit, or its backing source is gone. Moves it to .cairn/ground/.archive/, drops it from the active ledger. NOT a hard delete.",
  inputSchema: retireDecisionInput,
  handler: makeHandler("DEC"),
};

export const retireInvariantTool: ToolDef<Input> = {
  name: "cairn_retire_invariant",
  description:
    "Retire (archive) an active INV that no longer holds — refactored away, or its backing source is gone. Moves it to .cairn/ground/.archive/, drops it from the active ledger. NOT a hard delete.",
  inputSchema: retireInvariantInput,
  handler: makeHandler("INV"),
};
