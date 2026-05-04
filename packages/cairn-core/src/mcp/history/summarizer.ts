/**
 * Composes walker + Tier-1 summarizer + post-resolution of
 * currently_canonical_pointer for harness_query_history.
 *
 * Flow:
 *   1. walkArchive(repoRoot, pathHint, since, until) → ArchiveFile[]
 *   2. Load currently-accepted decisions ledger.
 *   3. Build summarizer prompt with files + ledger.
 *   4. runClaude(tier=haiku, jsonSchema=HISTORY_SUMMARIZER_OUTPUT_SCHEMA).
 *   5. Validate output structurally.
 *   6. Post-resolve currently_canonical_pointer per claim by looking up
 *      `superseded_by` against the on-disk decisions/ dir.
 *   7. Attach summarizer_model + summarizer_prompt_id metadata.
 *
 * Returns the structured QueryHistoryResponse the MCP tool emits.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../../claude/index.js";
import type { ClaudeTier } from "../../claude/index.js";
import { logger } from "../../logger.js";
import { decisionsDir } from "../../ground/index.js";
import { loadAcceptedDecisions } from "../../sensors/decisions.js";
import {
  buildHistorySummarizerUserPrompt,
  HARNESS_HISTORY_SUMMARIZE_PROMPT_ID,
  HISTORY_SUMMARIZER_SYSTEM_PROMPT,
} from "./prompt.js";
import { HISTORY_SUMMARIZER_OUTPUT_SCHEMA } from "./schema.js";
import { walkArchive, type ArchiveFile } from "./walker.js";

const log = logger("mcp.history.summarizer");

const HISTORICAL_WARNING =
  "This claim is HISTORICAL. Verify against the canonical pointer before acting.";

export interface SummarizedClaim {
  claim: string;
  as_of: string;
  source_path: string;
  source_lines: string;
  superseded_by: string | null;
  currently_canonical_pointer: string | null;
  warning: string;
}

export interface QueryHistoryResponse {
  historical_only: true;
  claims: SummarizedClaim[];
  summary_caveat: string;
  summarizer_model: string;
  summarizer_prompt_id: string;
  /** Structural metadata about the walk — useful for telemetry + tests. */
  walked_files: number;
  walked_buckets: string[];
  truncated_walk: boolean;
}

export interface RunQueryHistoryArgs {
  repoRoot: string;
  scope: string;
  pathHint?: string;
  since?: string;
  until?: string;
  /** Tier override; default haiku per workflow.md. */
  tier?: ClaudeTier;
  /** Per-call timeout. Default 120000 ms. */
  timeoutMs?: number;
  /** Smoke override — return canned summarizer output without burning quota. */
  summarizerOverride?: typeof runHistorySummarizer;
}

interface RunSummarizerInput {
  scope: string;
  pathHint?: string;
  since?: string;
  until?: string;
  files: ArchiveFile[];
  acceptedDecisions: { id: string; title: string; scope_globs?: string[] }[];
  tier: ClaudeTier;
  timeoutMs: number;
}

interface RunSummarizerResult {
  claims: { claim: string; as_of: string; source_path: string; source_lines: string; superseded_by: string | null }[];
  summary_caveat: string;
  no_relevant_history: boolean;
  model: string;
}

export async function runQueryHistory(
  args: RunQueryHistoryArgs,
): Promise<QueryHistoryResponse> {
  const tier = args.tier ?? "haiku";
  const timeoutMs = args.timeoutMs ?? 120_000;
  const summarize = args.summarizerOverride ?? runHistorySummarizer;

  const walkOpts: {
    repoRoot: string;
    pathHint?: string;
    since?: string;
    until?: string;
  } = { repoRoot: args.repoRoot };
  if (args.pathHint !== undefined) walkOpts.pathHint = args.pathHint;
  if (args.since !== undefined) walkOpts.since = args.since;
  if (args.until !== undefined) walkOpts.until = args.until;
  const walk = walkArchive(walkOpts);

  if (walk.files.length === 0) {
    return {
      historical_only: true,
      claims: [],
      summary_caveat: walk.bucketsScanned.length === 0
        ? "No .archive/ directory found at this repo root."
        : `No files matched the walk filters (path_hint, since, until) across ${walk.bucketsScanned.length} archive bucket${walk.bucketsScanned.length === 1 ? "" : "s"}.`,
      summarizer_model: "(skipped — no matches)",
      summarizer_prompt_id: HARNESS_HISTORY_SUMMARIZE_PROMPT_ID,
      walked_files: 0,
      walked_buckets: walk.bucketsScanned,
      truncated_walk: walk.capHit,
    };
  }

  const decisions = loadAcceptedDecisions(args.repoRoot).map((d) => {
    const entry: { id: string; title: string; scope_globs?: string[] } = {
      id: d.id,
      title: d.title,
    };
    if (d.scope_globs !== undefined) entry.scope_globs = d.scope_globs;
    return entry;
  });

  log.info(
    {
      repo: args.repoRoot,
      scope_preview: args.scope.slice(0, 80),
      files: walk.files.length,
      buckets: walk.bucketsScanned.length,
      total_bytes: walk.totalBytes,
      tier,
    },
    "history summarizer dispatch",
  );

  const summarizerInput: RunSummarizerInput = {
    scope: args.scope,
    files: walk.files,
    acceptedDecisions: decisions,
    tier,
    timeoutMs,
  };
  if (args.pathHint !== undefined) summarizerInput.pathHint = args.pathHint;
  if (args.since !== undefined) summarizerInput.since = args.since;
  if (args.until !== undefined) summarizerInput.until = args.until;
  const summary = await summarize(summarizerInput);

  const acceptedById = new Map<string, true>();
  for (const d of decisions) acceptedById.set(d.id, true);

  const claims: SummarizedClaim[] = summary.claims.map((c) => {
    const supersededBy = resolveSupersededBy(c.superseded_by, acceptedById);
    const pointer = supersededBy
      ? canonicalPointerFor(args.repoRoot, supersededBy)
      : null;
    return {
      claim: c.claim,
      as_of: c.as_of,
      source_path: c.source_path,
      source_lines: c.source_lines,
      superseded_by: supersededBy,
      currently_canonical_pointer: pointer,
      warning: HISTORICAL_WARNING,
    };
  });

  const caveatBits: string[] = [];
  if (summary.summary_caveat.trim().length > 0) caveatBits.push(summary.summary_caveat.trim());
  if (walk.capHit) {
    caveatBits.push(
      `Walk truncated — additional matching files were not summarized; refine path_hint / since / until and re-query.`,
    );
  }
  if (summary.no_relevant_history && claims.length === 0) {
    caveatBits.push("Summarizer found no claims relevant to the scope question.");
  }
  caveatBits.push(
    "All claims are dated and superseded-tagged. Do not treat any line as current truth. Cross-reference the canonical pointer (or call harness_decision_get / harness_canonical_for_topic) before acting.",
  );

  return {
    historical_only: true,
    claims,
    summary_caveat: caveatBits.join(" "),
    summarizer_model: summary.model,
    summarizer_prompt_id: HARNESS_HISTORY_SUMMARIZE_PROMPT_ID,
    walked_files: walk.files.length,
    walked_buckets: walk.bucketsScanned,
    truncated_walk: walk.capHit,
  };
}

/** Default summarizer implementation — runs the real LLM. */
export async function runHistorySummarizer(
  input: RunSummarizerInput,
): Promise<RunSummarizerResult> {
  const userPrompt = buildHistorySummarizerUserPrompt({
    scope: input.scope,
    files: input.files,
    acceptedDecisions: input.acceptedDecisions,
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
  });
  const result = await runClaude({
    tier: input.tier,
    prompt: userPrompt,
    system: HISTORY_SUMMARIZER_SYSTEM_PROMPT,
    jsonSchema: HISTORY_SUMMARIZER_OUTPUT_SCHEMA as object,
    timeoutMs: input.timeoutMs,
  });
  if (!isSummarizerOutput(result.parsed)) {
    throw new Error(
      `history summarizer returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }
  return {
    claims: result.parsed.claims.map((c) => ({
      claim: c.claim,
      as_of: c.as_of,
      source_path: c.source_path,
      source_lines: c.source_lines,
      superseded_by: c.superseded_by ?? null,
    })),
    summary_caveat: result.parsed.summary_caveat ?? "",
    no_relevant_history: result.parsed.no_relevant_history === true,
    model: result.model,
  };
}

interface SummarizerRawClaim {
  claim: string;
  as_of: string;
  source_path: string;
  source_lines: string;
  superseded_by?: string | null;
}

interface SummarizerRawOutput {
  claims: SummarizerRawClaim[];
  summary_caveat?: string;
  no_relevant_history?: boolean;
}

function isSummarizerOutput(v: unknown): v is SummarizerRawOutput {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o["claims"])) return false;
  for (const c of o["claims"] as unknown[]) {
    if (typeof c !== "object" || c === null) return false;
    const cc = c as Record<string, unknown>;
    if (typeof cc["claim"] !== "string") return false;
    if (typeof cc["as_of"] !== "string") return false;
    if (typeof cc["source_path"] !== "string") return false;
    if (typeof cc["source_lines"] !== "string") return false;
    if (
      cc["superseded_by"] !== undefined &&
      cc["superseded_by"] !== null &&
      typeof cc["superseded_by"] !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function resolveSupersededBy(
  proposed: string | null | undefined,
  acceptedById: Map<string, true>,
): string | null {
  if (proposed === undefined || proposed === null) return null;
  if (!/^DEC-\d{4,}$/.test(proposed)) return null;
  return acceptedById.has(proposed) ? proposed : null;
}

function canonicalPointerFor(repoRoot: string, decisionId: string): string | null {
  const path = join(decisionsDir(repoRoot), `${decisionId}.md`);
  if (!existsSync(path)) return null;
  return `.harness/ground/decisions/${decisionId}.md`;
}
