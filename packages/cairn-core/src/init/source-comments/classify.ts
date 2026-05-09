/**
 * Phase 7b — Haiku batch classifier for source-comment blocks.
 *
 * Walker outputs essay-style comment blocks; this module batches them per
 * Haiku call and returns one classification per block. Per plan §5.3 the
 * classifier returns *kind only* — no paraphrased title, no rewritten
 * invariant body, no canonical-topic suggestion. The verbatim comment
 * prose is the canonical body, recorded straight onto the DEC/INV the
 * ingest stage emits.
 *
 * Categories:
 *   - rationale  — explains *why* a non-obvious choice was made
 *   - constraint — states a domain/system invariant the code must obey
 *   - citation   — pointer to RFC / spec / ticket / docs
 *   - license    — copyright header (never strip, never canonicalize)
 *   - other      — banal narration, TODO chatter, debug notes
 *
 * Resilience:
 *   - one batch failure doesn't fail the run; the block is reported as
 *     `failed` with `kind: "other"` so the strip-replace stage skips it
 *   - partial JSON returned by Haiku (e.g. missing block_id) is tolerated;
 *     missing fields default to safe values
 */

import { z } from "zod";

const BatchEntrySchema = z.object({
  block_id: z.string(),
  kind: z.enum(["rationale", "constraint", "citation", "license", "other"]),
}).passthrough();

const BatchResultSchema = z.object({
  results: z.array(BatchEntrySchema),
}).passthrough();
import { runClaude } from "../../claude/index.js";
import { ClaudeError } from "../../claude/error.js";
import { logger } from "../../logger.js";
import type { CommentBlock } from "@isaacriehm/cairn-state";

const log = logger("init.source-comments.classify");

const BATCH_SIZE = 10;
const PER_BATCH_TIMEOUT_MS = 90_000;
const PROSE_CAP_PER_BLOCK = 1500;

/**
 * Concurrent Haiku batches per round. Haiku has higher TPM ceilings than
 * Sonnet so 4-at-a-time is well within rate limits even for large adoptions
 * (10k+ essay blocks → 500+ batches → ~125 rounds).
 */
const PARALLEL_ROUND_SIZE = 4;

export type CommentClassKind =
  | "rationale"
  | "constraint"
  | "citation"
  | "license"
  | "other";

export interface CommentClassification {
  blockId: string;
  kind: CommentClassKind;
  /** True when the Haiku call (or batch parse) failed for this block. */
  failed: boolean;
  errorMessage?: string;
}

export interface ClassifyArgs {
  blocks: CommentBlock[];
  /**
   * Optional progress callback fired after each batch completes. `index` is
   * the 0-based batch index, `total` is the total number of batches.
   */
  onBatchProgress?: (row: {
    index: number;
    total: number;
    classified: number;
    failed: number;
  }) => void;
  /**
   * Test override — when set, every block is classified by this function and
   * no Haiku call is made.
   */
  mockClassify?: (block: CommentBlock) => CommentClassification;
  /**
   * When set, every Haiku batch call is run with `cacheable: true` so
   * re-running adoption against the same source corpus hits the
   * `.cairn/cache/haiku/` cache instead of burning the operator's quota.
   */
  repoRoot?: string;
}

export interface ClassifyResult {
  classifications: CommentClassification[];
  /** Approximate input tokens — sum over batches when usage is reported. */
  inputTokens: number;
  /** Approximate output tokens — sum over batches when usage is reported. */
  outputTokens: number;
  batchesRun: number;
  batchesFailed: number;
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["block_id", "kind"],
        properties: {
          block_id: { type: "string" },
          kind: {
            type: "string",
            enum: ["rationale", "constraint", "citation", "license", "other"],
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You classify source-code comment blocks for Cairn adoption.

Each comment block in the batch has:
  - block_id   — the stable identifier you must echo back
  - file       — repo-relative source path
  - lang       — language token (js/py/rs/go/...)
  - kind       — block | jsdoc | line-cluster | license
  - prose      — the comment text with markers stripped

Return JSON: { "results": [ { block_id, kind } ] }

\`kind\` choices:
  - "rationale"  comment explains *why* a non-obvious choice was made (DEC candidate)
  - "constraint" comment states a domain/system invariant (§INV candidate)
  - "citation"   comment is a reference to docs/spec/issue (canonical-map candidate)
  - "license"    comment is a license / copyright header — pass through, never strip
  - "other"      banal narration ("returns the user object"), TODO chatter, debug notes

Heuristics:
  - One sentence about what code does = "other".
  - Multi-paragraph rationale tying behavior to a domain rule = "rationale".
  - Hard-coded business rule that's wrong if violated = "constraint".
  - Cross-reference to RFC / spec / ticket / docs = "citation".

Be conservative. When in doubt, "other". Always echo the block_id verbatim.`;

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function classifyBlocks(args: ClassifyArgs): Promise<ClassifyResult> {
  const blocks = args.blocks;
  const total = Math.ceil(blocks.length / BATCH_SIZE);
  const out: CommentClassification[] = new Array(blocks.length);
  const repoRoot = args.repoRoot;

  if (args.mockClassify !== undefined) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b === undefined) continue;
      out[i] = args.mockClassify(b);
    }
    return {
      classifications: out,
      inputTokens: 0,
      outputTokens: 0,
      batchesRun: total,
      batchesFailed: 0,
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let batchesRun = 0;
  let batchesFailed = 0;

  // Dispatch batches in parallel rounds. Each batch is independent — its
  // start index is `batchIdx * BATCH_SIZE` and writes only to that slice of
  // `out`, so concurrent Promise.allSettled is safe.
  const runOneBatch = async (
    batchIdx: number,
  ): Promise<{ batchIdx: number; outcome: BatchOutcome }> => {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, blocks.length);
    const batch = blocks.slice(start, end);
    try {
      const outcome = await classifyOneBatchWithRetry(batch, repoRoot);
      return { batchIdx, outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ batchIdx, total, err: msg }, "batch classify failed");
      return {
        batchIdx,
        outcome: {
          byId: new Map(),
          inputTokens: 0,
          outputTokens: 0,
          errorMessage: msg,
        },
      };
    }
  };

  for (let roundStart = 0; roundStart < total; roundStart += PARALLEL_ROUND_SIZE) {
    const roundEnd = Math.min(roundStart + PARALLEL_ROUND_SIZE, total);
    const indices: number[] = [];
    for (let i = roundStart; i < roundEnd; i++) indices.push(i);
    const settled = await Promise.allSettled(indices.map(runOneBatch));
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { batchIdx, outcome } = s.value;
      const start = batchIdx * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, blocks.length);
      const batch = blocks.slice(start, end);
      if (outcome.errorMessage === undefined) {
        batchesRun += 1;
        inputTokens += outcome.inputTokens;
        outputTokens += outcome.outputTokens;
      } else {
        batchesFailed += 1;
      }
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i];
        if (b === undefined) continue;
        const pre = outcome.byId.get(b.id);
        if (pre !== undefined) {
          out[start + i] = pre;
        } else {
          out[start + i] = {
            blockId: b.id,
            kind: b.kind === "license" ? "license" : "other",
            failed: outcome.errorMessage !== undefined,
            ...(outcome.errorMessage !== undefined
              ? { errorMessage: outcome.errorMessage }
              : {}),
          };
        }
      }
      args.onBatchProgress?.({
        index: batchIdx,
        total,
        classified: out.filter((c) => c !== undefined && !c.failed).length,
        failed: out.filter((c) => c !== undefined && c.failed).length,
      });
    }
  }

  return {
    classifications: out,
    inputTokens,
    outputTokens,
    batchesRun,
    batchesFailed,
  };
}

/* -------------------------------------------------------------------------- */
/* Batch internals                                                            */
/* -------------------------------------------------------------------------- */

interface BatchOutcome {
  byId: Map<string, CommentClassification>;
  inputTokens: number;
  outputTokens: number;
  errorMessage?: string;
}

/**
 * Wraps `classifyOneBatch` with timeout-triggered half-split retry. When the
 * first attempt aborts via SIGTERM (`error_kind: "timeout"`), splits the batch
 * in half and re-issues both halves with the full per-batch timeout. Halves
 * smaller than 2 are not split — they propagate the original error.
 *
 * Recovers most residual loss after the BATCH_SIZE 20→10 reduction; defends
 * against tail-latency spikes from upstream Haiku capacity.
 */
async function classifyOneBatchWithRetry(
  batch: CommentBlock[],
  repoRoot: string | undefined,
): Promise<BatchOutcome> {
  try {
    return await classifyOneBatch(batch, repoRoot);
  } catch (err) {
    const isTimeout = err instanceof ClaudeError && err.kind === "timeout";
    if (!isTimeout || batch.length < 2) {
      throw err;
    }
    log.warn(
      { batchSize: batch.length },
      "batch timed out, splitting in half + retrying",
    );
    const half = Math.floor(batch.length / 2);
    const left = batch.slice(0, half);
    const right = batch.slice(half);
    const [aRes, bRes] = await Promise.allSettled([
      classifyOneBatch(left, repoRoot),
      classifyOneBatch(right, repoRoot),
    ]);
    const merged = new Map<string, CommentClassification>();
    let inputTokens = 0;
    let outputTokens = 0;
    let errorMessage: string | undefined;
    for (const r of [aRes, bRes]) {
      if (r.status === "fulfilled") {
        for (const [k, v] of r.value.byId) merged.set(k, v);
        inputTokens += r.value.inputTokens;
        outputTokens += r.value.outputTokens;
        if (r.value.errorMessage !== undefined) errorMessage = r.value.errorMessage;
      } else {
        const msg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        errorMessage = msg;
      }
    }
    return {
      byId: merged,
      inputTokens,
      outputTokens,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }
}

async function classifyOneBatch(
  batch: CommentBlock[],
  repoRoot: string | undefined,
): Promise<BatchOutcome> {
  const prompt = buildBatchPrompt(batch);
  const result = await runClaude({
    tier: "haiku",
    system: SYSTEM_PROMPT,
    prompt,
    jsonSchema: BATCH_SCHEMA,
    timeoutMs: PER_BATCH_TIMEOUT_MS,
    isolateAmbientContext: true,
    ...(repoRoot !== undefined ? { repoRoot, cacheable: true } : {}),
  });
  const usage = result.usage;
  const inputTokens =
    typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  const outputTokens =
    typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  const parsed = result.parsed;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("haiku batch returned non-object payload");
  }
  const obj = parsed as Record<string, unknown>;
  const arr = Array.isArray(obj["results"]) ? obj["results"] : [];
  const byId = new Map<string, CommentClassification>();
  for (const entryRaw of arr) {
    if (typeof entryRaw !== "object" || entryRaw === null) continue;
    const entry = entryRaw as Record<string, unknown>;
    const blockId = typeof entry["block_id"] === "string" ? entry["block_id"] : "";
    if (blockId.length === 0) continue;
    const kindRaw = entry["kind"];
    const kind: CommentClassKind =
      kindRaw === "rationale" ||
      kindRaw === "constraint" ||
      kindRaw === "citation" ||
      kindRaw === "license"
        ? kindRaw
        : "other";
    byId.set(blockId, {
      blockId,
      kind,
      failed: false,
    });
  }
  return { byId, inputTokens, outputTokens };
}

function buildBatchPrompt(batch: CommentBlock[]): string {
  const lines: string[] = [];
  lines.push(
    `You are classifying ${batch.length} source-comment block${batch.length === 1 ? "" : "s"}.`,
  );
  lines.push(
    "Echo every block_id in the same order. Use the schema exactly. Be terse.",
  );
  lines.push("");
  for (const b of batch) {
    const prose =
      b.prose.length > PROSE_CAP_PER_BLOCK
        ? `${b.prose.slice(0, PROSE_CAP_PER_BLOCK)}\n…[truncated]`
        : b.prose;
    lines.push("---");
    lines.push(`block_id: ${b.id}`);
    lines.push(`file: ${b.file}`);
    lines.push(`lang: ${b.lang}`);
    lines.push(`kind: ${b.kind}`);
    lines.push(`lines: ${b.lineCount}`);
    lines.push(`words: ${b.wordCount}`);
    lines.push("prose: |");
    for (const line of prose.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

const _internal = {
  buildBatchPrompt,
  classifyOneBatchWithRetry,
  BATCH_SIZE,
  BATCH_SCHEMA,
  SYSTEM_PROMPT,
};
