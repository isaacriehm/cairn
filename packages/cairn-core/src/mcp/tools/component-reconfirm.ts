import { isGhost } from "@isaacriehm/cairn-state";
import { runComponentReconfirm } from "../../components/reconfirm.js";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { componentReconfirmInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  file?: string;
  cap?: number;
}

/**
 * Re-confirm headerless components the freshness gate flagged as
 * identity-changed (§3.8.1). Ghost-only. Runs the narrow **Haiku** yes/no
 * judge ("does the stored category/purpose still fit?") over flagged entries —
 * "fits" clears the flag, "stale" leaves it for the operator to re-register.
 * Verdicts are cached on the body fingerprint and the run is hard-capped, so a
 * sweep can't runaway-burn quota. This is the deferred, quota-expected reclassify
 * pass — never the hot edit path. Committed projects have no headerless registry,
 * so the tool refuses there.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  if (!isGhost(ctx.repoRoot)) {
    return mcpError(
      "NOT_ALLOWED",
      "cairn_component_reconfirm is the ghost-mode reclassify pass. Committed projects carry no headerless registry — re-confirm a component by editing its in-file `@cairn` header instead.",
    );
  }
  const res = await runComponentReconfirm({
    repoRoot: ctx.repoRoot,
    ...(input.file !== undefined ? { onlyFile: input.file } : {}),
    ...(input.cap !== undefined ? { cap: input.cap } : {}),
  });
  return {
    considered: res.considered,
    cleared: res.cleared,
    still_flagged: res.stillStale + res.deferred,
    deferred: res.deferred,
    haiku_calls: res.haikuCalls,
    cache_hits: res.cacheHits,
  };
}

export const componentReconfirmTool: ToolDef<Input> = {
  name: "cairn_component_reconfirm",
  description:
    "Ghost mode only. Re-confirm components the freshness gate flagged as identity-changed: a narrow Haiku judge decides whether each one's stored category/purpose still fits its current code. 'fits' clears the flag; 'stale' leaves it for you to re-register via cairn_component_register. Pass `file` to reconfirm one unit, or omit to sweep all flagged. `cap` bounds Haiku calls per run (rest deferred). Verdicts cache on the body fingerprint. Refuses in committed mode.",
  inputSchema: componentReconfirmInput,
  handler,
};
