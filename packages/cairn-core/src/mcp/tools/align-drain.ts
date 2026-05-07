import { runDrain } from "../../drain/index.js";
import type { McpContext } from "../context.js";
import { alignDrainInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  max_haiku_calls?: number;
  dry_run?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const args: Parameters<typeof runDrain>[0] = {
    repoRoot: ctx.repoRoot,
    sessionId: ctx.sessionId ?? null,
  };
  if (input.max_haiku_calls !== undefined) args.maxHaikuCalls = input.max_haiku_calls;
  if (input.dry_run !== undefined) args.dryRun = input.dry_run;
  const result = await runDrain(args);
  return result;
}

export const alignDrainTool: ToolDef<Input> = {
  name: "cairn_align_drain",
  description:
    "Layer C SessionStart drain (plan §4.3). Reads .cairn/staleness/layer-a-deferred.jsonl + " +
    "pre-commit-deferred.jsonl, re-checks each block against the current source, applies " +
    "verdict (cite / drop / alignment-pending) using the Haiku dedup judge for ambiguous " +
    "candidates, and truncates the deferred logs. Capped at max_haiku_calls (default 30). " +
    "Returns counts: cited, pending, dropped, deferred, haiku calls. Idempotent. dry_run " +
    "classifies without applying side effects.",
  inputSchema: alignDrainInput,
  handler,
};
