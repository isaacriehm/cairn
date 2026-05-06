/**
 * `cairn_attention_restore` MCP tool.
 *
 * Move a previously rejected or accepted DEC back into `_inbox/` as a
 * draft so the operator can re-evaluate via the normal
 * `cairn_resolve_attention` flow. See `attention/restore.ts` for the
 * exact semantics around source-cite preservation.
 */

import { z } from "zod";
import { restoreDec } from "../../attention/index.js";
import type { McpContext } from "../context.js";
import type { ToolDef } from "./types.js";

const inputShape = {
  decId: z.string().regex(/^DEC-[0-9a-f]{7,}$/),
};

interface RestoreInput {
  decId: string;
}

export const attentionRestoreTool: ToolDef<RestoreInput> = {
  name: "cairn_attention_restore",
  description:
    "Move a previously rejected or accepted DEC back to draft state in `_inbox/<id>.draft.md` so the operator can re-evaluate via cairn_resolve_attention. Rejected DECs round-trip cleanly. Accepted DECs lose their canonical entry + ledger row but the inline `// §DEC-NNNN` source cite stays — re-accepting is idempotent (handled by the already-stripped check). Returns the prior state (`rejected` | `accepted` | `draft` | `not-found`) and the new draft path.",
  inputSchema: inputShape,
  handler: async (ctx: McpContext, input: RestoreInput) => {
    return await restoreDec({ repoRoot: ctx.repoRoot, decId: input.decId });
  },
};
