/**
 * `cairn_reject_candidate` — append a topic-index slug to
 * `.cairn/ground/_rejected.yaml` so phase 6 / `cairn ingest` /
 * `cairn_propose_decision` skip it on the next pass.
 *
 *  Dedup by slug — first writer wins the
 * `reason` string; subsequent writes only refresh `rejected_at`. The
 * AI-curator path stamps `rejected_by: "ai-curator"`; operator-driven
 * rejections (`cairn-attention` skill) reuse the same writer with
 * `rejected_by: "operator"`.
 *
 * Refusal modes:
 *   - `not_found` — slug not present in the topic-index. We refuse so
 *                   stale agent calls can't poison the rejection
 *                   ledger with phantom slugs that the GC pass would
 *                   immediately drop.
 */

import {
  appendRejected,
  readRejectedYaml,
  readTopicIndex,
  writeRejectedYaml,
  type RejectedEntry,
} from "../../ground/index.js";
import { withWriteLock } from "../../lock.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { rejectCandidateInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  slug: string;
  reason: string;
}

interface RejectCandidateResult {
  ok: boolean;
  slug?: string;
  reason?: "not_found";
  detail?: string;
  warning?: string;
}

const REJECTED_BY = "ai-curator";

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  return withWriteLock(ctx.repoRoot, () => {
    const topicIndex = readTopicIndex(ctx.repoRoot);
    const entry = topicIndex.topics[input.slug];
    if (entry === undefined) {
      return {
        ok: false,
        reason: "not_found",
        detail: `slug "${input.slug}" not in topic-index`,
      } satisfies RejectCandidateResult;
    }

    const sot = entry.candidates.find((c) => c.file === entry.sot_source);
    const now = new Date().toISOString();
    const record: RejectedEntry = {
      slug: input.slug,
      rejected_at: now,
      rejected_by: REJECTED_BY,
      reason: input.reason,
      sot_source: entry.sot_source,
      ...(sot?.line_range !== undefined ? { line_range: sot.line_range } : {}),
    };

    const current = readRejectedYaml(ctx.repoRoot);
    const existing = current.get(input.slug);
    const next = appendRejected(current, record);
    writeRejectedYaml(ctx.repoRoot, next);

    if (existing !== undefined) {
      return {
        ok: true,
        slug: input.slug,
        warning:
          `Slug ${input.slug} was already rejected by ${existing.rejected_by} (${existing.reason}). ` +
          `Refreshed rejected_at; original reason preserved.`,
      } satisfies RejectCandidateResult;
    }
    return {
      ok: true,
      slug: input.slug,
    } satisfies RejectCandidateResult;
  });
}

export const rejectCandidateTool: ToolDef<Input> = {
  name: "cairn_reject_candidate",
  description:
    "Mark a topic-index slug as not-a-decision in `.cairn/ground/_rejected.yaml`. Phase 6 / cairn ingest / cairn_propose_decision skip rejected slugs. Dedup by slug; first writer wins the reason string. Use when the candidate is research, narrative, plan, status, or otherwise not a binding rule.",
  inputSchema: rejectCandidateInput,
  handler,
};
