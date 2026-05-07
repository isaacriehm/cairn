/**
 * `cairn_search_candidates` — query topic-index entries that haven't
 * been promoted to a DEC yet (`dec_id IS NULL`).
 *
 * Spec:  Mirrors the response shape of
 * `cairn_decisions_in_scope` so AI agents can use the two
 * interchangeably during the daily read-enrich-driven curator flow.
 *
 * The slugs returned by this tool are exactly the slugs accepted by
 * `cairn_propose_decision` and `cairn_reject_candidate`.
 */

import type { McpContext } from "../context.js";
import {
  matchGlob,
  readRejectedYaml,
  readTopicIndex,
  type TopicIndexEntry,
} from "../../ground/index.js";
import { readSotBody } from "../../init/sot-emit.js";
import { readAnchorMap } from "../../ground/index.js";
import { searchCandidatesInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  query?: string;
  scope?: string;
  kind?: "decision" | "rule";
  limit?: number;
}

interface CandidateSummary {
  slug: string;
  title: string;
  sot_source: string;
  line_range?: [number, number];
  marker_kind?: "decision" | "rule";
  body_preview: string;
}

/** Matches the body-preview cap used elsewhere when surfacing prose to AI agents. */
const BODY_PREVIEW_CHARS = 280;
const DEFAULT_LIMIT = 50;

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, 200);
  const topicIndex = readTopicIndex(ctx.repoRoot);
  const anchorMap = readAnchorMap(ctx.repoRoot);
  const rejected = readRejectedYaml(ctx.repoRoot);

  const q = input.query !== undefined ? input.query.toLowerCase() : null;
  const scope = input.scope ?? null;

  const out: CandidateSummary[] = [];
  for (const entry of Object.values(topicIndex.topics)) {
    if (entry.dec_id !== undefined) continue;
    if (rejected.has(entry.slug)) continue;
    if (input.kind !== undefined && entry.marker_kind !== input.kind) continue;
    if (scope !== null && !matchGlob(entry.sot_source, scope)) continue;

    const body = readSotBody(ctx.repoRoot, entry, anchorMap) ?? "";
    const title = deriveTitle(entry, body);

    if (q !== null) {
      const titleHit = title.toLowerCase().includes(q);
      const bodyHit = body.toLowerCase().includes(q);
      if (!titleHit && !bodyHit) continue;
    }

    const sot = entry.candidates.find((c) => c.file === entry.sot_source);
    const summary: CandidateSummary = {
      slug: entry.slug,
      title,
      sot_source: entry.sot_source,
      body_preview: previewBody(body),
    };
    if (sot?.line_range !== undefined) summary.line_range = sot.line_range;
    if (entry.marker_kind !== undefined) summary.marker_kind = entry.marker_kind;
    out.push(summary);
  }

  // Stable ordering: marker-kinded first, then alpha by sot_source so
  // pagination via `limit` is predictable across runs.
  out.sort((a, b) => {
    const am = a.marker_kind !== undefined ? 0 : 1;
    const bm = b.marker_kind !== undefined ? 0 : 1;
    if (am !== bm) return am - bm;
    if (a.sot_source !== b.sot_source) return a.sot_source.localeCompare(b.sot_source);
    return a.slug.localeCompare(b.slug);
  });
  return out.slice(0, limit);
}

function deriveTitle(entry: TopicIndexEntry, body: string): string {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot?.anchor !== undefined && sot.anchor.length > 0) {
    return sot.anchor.replace(/[-_]+/g, " ").trim().slice(0, 120) || firstLineFallback(body);
  }
  return firstLineFallback(body);
}

function firstLineFallback(body: string): string {
  const first = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^#+\s*/, "").trim().slice(0, 120) || "(untitled)";
}

function previewBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= BODY_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_CHARS)}…`;
}

export const searchCandidatesTool: ToolDef<Input> = {
  name: "cairn_search_candidates",
  description:
    "List unpromoted topic-index candidates (slugs whose `dec_id` is null). Filter by `query` (substring on title/body), `scope` (glob on sot_source), or `kind` (marker_kind). Returned slugs feed `cairn_propose_decision` and `cairn_reject_candidate`.",
  inputSchema: searchCandidatesInput,
  handler,
};
