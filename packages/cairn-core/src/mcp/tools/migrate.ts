/**
 * `cairn_migrate` — apply pending `review`-class `.cairn/` migrations inline.
 *
 * `safe`-class migrations auto-apply silently on session open. The
 * `review`-class ones rewrite source / hard-delete state / make a judgement
 * call, so they wait for a human. Historically that wait was a CLI nudge
 * ("run `cairn migrate --all`") the operator had to act on out-of-band — the
 * agent could see the pending list at SessionStart but had no in-session verb
 * to clear it. This tool IS that verb: the SessionStart migration banner now
 * points the agent here, so it can explain each pending migration and apply
 * them in the same turn once the operator says go.
 *
 * `dry_run` previews (what would apply / queue, no writes). The default
 * applies the full set, review included.
 */

import { runMigrations } from "../../migrate/index.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { migrateInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  dry_run?: boolean;
}

export const migrateTool: ToolDef<Input> = {
  name: "cairn_migrate",
  description:
    "Apply pending review-class `.cairn/` migrations — the ones the SessionStart 'Cairn — migrations' banner flagged as needing confirmation. These rewrite or hard-delete committed state (e.g. dropping dead init scaffolding, untracking committed derived state), so summarize what each does and get the operator's OK before calling. Pass dry_run:true to preview without writing. Safe-class migrations already auto-applied on session open — this is only for the review-class queue.",
  inputSchema: migrateInput,
  handler: async (ctx: McpContext, input: Input): Promise<unknown> => {
    const block = requireBootstrap(ctx.repoRoot);
    if (block !== null) return block;
    const dryRun = input.dry_run === true;
    const result = await runMigrations({
      repoRoot: ctx.repoRoot,
      includeReview: true,
      dryRun,
    });
    return {
      ok: true,
      dry_run: dryRun,
      pin: result.pin,
      new_pin: result.newPin,
      current: result.current,
      applied: result.outcomes
        .filter((o) => o.status === "applied" || o.status === "would-apply")
        .map((o) => ({ id: o.id, class: o.class, status: o.status, detail: o.detail })),
      still_pending: result.pendingReview,
      note:
        result.ran === false
          ? "another process holds the migrate lock — nothing applied this call"
          : undefined,
    };
  },
};
