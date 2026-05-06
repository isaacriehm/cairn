/**
 * `cairn_attention_dedup` MCP tool.
 *
 * Wraps `findDuplicateClusters` so the cairn-attention skill can render
 * a `## Potential duplicates` section before per-draft triage prompts.
 * Pure-deterministic (no LLM, no quota burn) — token-Jaccard over the
 * frontmatter title + the first 500 chars of body, two-tier thresholds:
 *   - `>= 0.5` definite duplicates → skill offers merge-by-default
 *   - `0.4..0.5` potential duplicates → flagged for review
 *
 * Skill renders the cluster summary, then drives the operator through
 * triage with `cairn_resolve_attention(choice='b', kind='decision_draft')`
 * to reject the duplicates and keep the survivor.
 */

import { z } from "zod";
import {
  DEFAULT_THRESHOLD_DEFINITE,
  DEFAULT_THRESHOLD_FLOOR,
  findDuplicateClusters,
} from "../../attention/index.js";
import type { McpContext } from "../context.js";
import type { ToolDef } from "./types.js";

const inputShape = {
  thresholdFloor: z.number().min(0).max(1).optional(),
  thresholdDefinite: z.number().min(0).max(1).optional(),
};

interface DedupInput {
  thresholdFloor?: number;
  thresholdDefinite?: number;
}

export const attentionDedupTool: ToolDef<DedupInput> = {
  name: "cairn_attention_dedup",
  description:
    "Cluster pending DEC drafts in `_inbox/` by token-Jaccard similarity. Returns clusters of likely-duplicate drafts the cairn-attention skill renders before per-item triage. Two tiers: definite (Jaccard >= 0.5) and potential (0.4..0.5). Pure-deterministic, no Haiku, no quota burn — same input gives the same clusters every time. Defaults: floor 0.4, definite 0.5.",
  inputSchema: inputShape,
  handler: async (ctx: McpContext, input: DedupInput) => {
    const result = findDuplicateClusters({
      repoRoot: ctx.repoRoot,
      thresholdFloor: input.thresholdFloor ?? DEFAULT_THRESHOLD_FLOOR,
      thresholdDefinite: input.thresholdDefinite ?? DEFAULT_THRESHOLD_DEFINITE,
    });
    return result;
  },
};
