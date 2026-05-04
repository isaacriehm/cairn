/**
 * Phase 7b — Haiku batch classifier for source-comment blocks.
 *
 * Walker outputs essay-style comment blocks; this module batches 20 per Haiku
 * call and returns one classification per block. Per spec §15 the categories
 * are: rationale | constraint | citation | license | other.
 *
 * Cost ceiling: full (operator picked "no cap" per RESUME §Open / deferred).
 *
 * Resilience:
 *   - one batch failure doesn't fail the run; the block is reported as
 *     `failed` with `kind: "other"` so the strip-replace stage skips it
 *   - partial JSON returned by Haiku (e.g. missing block_id) is tolerated;
 *     missing fields default to safe values
 */

import { runClaude } from "../../claude/index.js";
import { logger } from "../../logger.js";
import type { CommentBlock } from "./walker.js";

const log = logger("init.source-comments.classify");

const BATCH_SIZE = 20;
const PER_BATCH_TIMEOUT_MS = 90_000;
const PROSE_CAP_PER_BLOCK = 1500;

export type CommentClassKind =
  | "rationale"
  | "constraint"
  | "citation"
  | "license"
  | "other";

export interface CommentClassification {
  blockId: string;
  kind: CommentClassKind;
  /** Proposed DEC draft title — non-empty only when classifier suggests one. */
  suggestedDecDraft: string;
  /** Proposed §V invariant body — non-empty only when classifier suggests one. */
  suggestedInvariant: string;
  /** Canonical-map topic slug. */
  suggestedCanonicalTopic: string;
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
          suggested_dec_draft: { type: "string" },
          suggested_invariant: { type: "string" },
          suggested_canonical_topic: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You classify source-code comment blocks for Harness adoption.

Each comment block in the batch has:
  - block_id   — the stable identifier you must echo back
  - file       — repo-relative source path
  - lang       — language token (js/py/rs/go/...)
  - kind       — block | jsdoc | line-cluster | license
  - prose      — the comment text with markers stripped

Return JSON: { "results": [ { block_id, kind, suggested_dec_draft?, suggested_invariant?, suggested_canonical_topic? } ] }

\`kind\` choices:
  - "rationale"  comment explains *why* a non-obvious choice was made (DEC candidate)
  - "constraint" comment states a domain/system invariant (§V candidate)
  - "citation"   comment is a reference to docs/spec/issue (canonical-map candidate)
  - "license"    comment is a license / copyright header — pass through, never strip
  - "other"      banal narration ("returns the user object"), TODO chatter, debug notes

Heuristics:
  - One sentence about what code does = "other".
  - Multi-paragraph rationale tying behavior to a domain rule = "rationale".
  - Hard-coded business rule that's wrong if violated = "constraint".
  - Cross-reference to RFC / spec / ticket / docs = "citation".

Optional fields:
  - suggested_dec_draft        5-10 word imperative title; populate only for "rationale"
  - suggested_invariant        1-sentence invariant body; populate only for "constraint"
  - suggested_canonical_topic  kebab-case topic slug; populate when topic is clear

Be conservative. When in doubt, "other". Always echo the block_id verbatim.`;

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function classifyBlocks(args: ClassifyArgs): Promise<ClassifyResult> {
  const blocks = args.blocks;
  const total = Math.ceil(blocks.length / BATCH_SIZE);
  const out: CommentClassification[] = new Array(blocks.length);

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

  for (let batchIdx = 0; batchIdx < total; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, blocks.length);
    const batch = blocks.slice(start, end);
    let batchResult: BatchOutcome;
    try {
      batchResult = await classifyOneBatch(batch);
      batchesRun += 1;
      inputTokens += batchResult.inputTokens;
      outputTokens += batchResult.outputTokens;
    } catch (err) {
      batchesFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ batchIdx, total, err: msg }, "batch classify failed");
      batchResult = {
        byId: new Map(),
        inputTokens: 0,
        outputTokens: 0,
        errorMessage: msg,
      };
    }
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      if (b === undefined) continue;
      const pre = batchResult.byId.get(b.id);
      if (pre !== undefined) {
        out[start + i] = pre;
      } else {
        out[start + i] = {
          blockId: b.id,
          kind: b.kind === "license" ? "license" : "other",
          suggestedDecDraft: "",
          suggestedInvariant: "",
          suggestedCanonicalTopic: "",
          failed: batchResult.errorMessage !== undefined,
          ...(batchResult.errorMessage !== undefined
            ? { errorMessage: batchResult.errorMessage }
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

async function classifyOneBatch(batch: CommentBlock[]): Promise<BatchOutcome> {
  const prompt = buildBatchPrompt(batch);
  const result = await runClaude({
    tier: "haiku",
    system: SYSTEM_PROMPT,
    prompt,
    jsonSchema: BATCH_SCHEMA,
    timeoutMs: PER_BATCH_TIMEOUT_MS,
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
      suggestedDecDraft:
        typeof entry["suggested_dec_draft"] === "string"
          ? entry["suggested_dec_draft"]
          : "",
      suggestedInvariant:
        typeof entry["suggested_invariant"] === "string"
          ? entry["suggested_invariant"]
          : "",
      suggestedCanonicalTopic:
        typeof entry["suggested_canonical_topic"] === "string"
          ? entry["suggested_canonical_topic"]
          : "",
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

export const _internal = {
  buildBatchPrompt,
  BATCH_SIZE,
  BATCH_SCHEMA,
  SYSTEM_PROMPT,
};
