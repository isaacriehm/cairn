/**
 * Layer C — SessionStart drain (plan §4.3).
 *
 * Reads the rich deferred logs written by Layer A
 * (`.cairn/staleness/layer-a-deferred.jsonl`) and Layer B
 * (`.cairn/staleness/pre-commit-deferred.jsonl`), re-checks each entry
 * against the current source location, and applies one of three
 * verdicts to each surviving entry:
 *
 *   - `same`       → strip-replace the prose block with `// §DEC-<id>`
 *                    cite. Pure deterministic for Layer B `tier1`
 *                    entries (the pre-commit hook already passed the
 *                    Tier 1 floors); Haiku-judged for everything else.
 *   - `different`  → drop the entry, no source change.
 *   - `ambiguous`  → write to `.cairn/ground/alignment-pending/` so
 *                    the cairn-attention skill surfaces a side-by-side
 *                    review next session.
 *
 * Drain truncates both deferred logs after running. The lightweight
 * drift events in `.cairn/staleness/log.jsonl` are an audit trail and
 * stay.
 *
 * Cost: capped at `max_haiku_calls` (default 30 per plan §4.3 budget).
 * Excess entries stay in the deferred logs for the next drain. Each
 * Haiku call is verdict-cached at
 * `.cairn/cache/haiku/drain-judge/<blockHash>-<decId>.json` keyed on
 * `(block_content_hash, dec_body_hash)`, so re-running the same block
 * against the same DEC body short-circuits without burning a call.
 *
 * Haiku unavailable fallback: drain attempts the deterministic re-check
 * pass only (Layer B tier1 entries get applied; everything else stays
 * deferred). `setHaikuAvailable(false)` raises the statusline banner.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSafe } from "../fs.js";
import { z, type ZodType } from "zod";
import { runClaude, claudeIsAvailable } from "../claude/index.js";
import {
  bodyContentHash,
  haikuCacheDir,
  layerADeferredLogPath,
  preCommitDeferredLogPath,
  readSotCache,
  recordDriftEvent,
  type SotCacheEntry,
  writeAlignmentPending,
} from "../ground/index.js";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "../init/source-comments/strip-replace.js";
import {
  TIER2_JACCARD_FLOOR,
  TOP_K_CANDIDATES,
  extractBlocks,
  isMarkdownPath,
  readEntityBody,
  topKCandidates,
} from "../hooks/sot-align-common.js";
import type { CommentBlock } from "../init/source-comments/index.js";
import { logger } from "../logger.js";
import { pushEvent, setHaikuAvailable } from "../status-line/event-queue.js";
import { tokenize } from "../text/jaccard.js";

const log = logger("drain");

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_HAIKU_CALLS = 30;
const PER_HAIKU_TIMEOUT_MS = 30_000;
const BLOCK_BODY_CAP = 1_500;
const SUMMARY_BLIP_THRESHOLD = 20;

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export type DrainJudgeVerdict = "same" | "different" | "ambiguous";

export interface DrainArgs {
  repoRoot: string;
  /** When provided, drain pushes drain-progress / drain-done blips to this session's queue. */
  sessionId?: string | null;
  /** Hard cap on Haiku judge calls. Default 30 (plan §4.3). */
  maxHaikuCalls?: number;
  /** Dry run — classify but do not strip-replace, write alignment-pending, or truncate logs. */
  dryRun?: boolean;
  /**
   * Inject the dedup judge — bypasses the live Haiku call. Used by
   * smoke fixtures and the `cairn align drain --mock` debug path.
   */
  mockJudge?: (args: {
    blockBody: string;
    candidate: { id: string; body: string };
  }) => Promise<DrainJudgeVerdict>;
  /** Override Haiku availability detection (smoke fixtures). */
  haikuAvailable?: boolean;
}

export interface DrainResult {
  /** Total entries read from both deferred logs. */
  totalEntries: number;
  /** Entries whose source block could not be relocated (gone / edited / cited). */
  droppedMissing: number;
  /** Entries auto-cited via deterministic re-check (Layer B tier1). */
  citedDeterministic: number;
  /** Entries auto-cited via Haiku `same` verdict. */
  citedHaiku: number;
  /** Entries dropped via Haiku `different` verdict. */
  droppedDifferent: number;
  /** Entries written to alignment-pending via Haiku `ambiguous` verdict. */
  pending: number;
  /** Entries left in the deferred logs because the Haiku cap was hit or Haiku is offline. */
  deferred: number;
  /** Total Haiku calls actually issued (cache hits do not count). */
  haikuCalls: number;
  /** True when the drain ran without Haiku (fallback path). */
  haikuFallback: boolean;
}

/* -------------------------------------------------------------------------- */
/* Entry shape parsing                                                        */
/* -------------------------------------------------------------------------- */

const LayerADeferredEntry = z.object({
  ts: z.string(),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  startOffset: z.number(),
  endOffset: z.number(),
  prose: z.string(),
  reason: z.string(),
});

const PreCommitCandidate = z.object({
  id: z.string(),
  similarity: z.number(),
  body_hash: z.string(),
  sot_path: z.string(),
});

const PreCommitEntry = z.object({
  ts: z.string(),
  file: z.string(),
  block_start_line: z.number(),
  block_end_line: z.number(),
  block_content_hash: z.string(),
  block_prose: z.string(),
  tier: z.enum(["tier1", "tier2-3"]),
  candidates: z.array(PreCommitCandidate),
});

interface NormalizedEntry {
  source: "layer-a" | "pre-commit-tier1" | "pre-commit-tier2-3";
  file: string;
  prose: string;
  /** First-seen Tier 1 candidate (pre-commit-tier1 only). */
  tier1Candidate?: { id: string; body_hash: string };
}

function readJsonl<T>(path: string, parser: ZodType<T>): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return [];
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      out.push(parser.parse(parsed));
    } catch (err) {
      log.warn(
        { path, err: err instanceof Error ? err.message : String(err) },
        "skipping malformed deferred log entry",
      );
    }
  }
  return out;
}

function loadDeferredEntries(repoRoot: string): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];
  for (const e of readJsonl(layerADeferredLogPath(repoRoot), LayerADeferredEntry)) {
    out.push({ source: "layer-a", file: e.file, prose: e.prose });
  }
  for (const e of readJsonl(preCommitDeferredLogPath(repoRoot), PreCommitEntry)) {
    if (e.tier === "tier1") {
      const top = e.candidates[0];
      if (top !== undefined) {
        out.push({
          source: "pre-commit-tier1",
          file: e.file,
          prose: e.block_prose,
          tier1Candidate: { id: top.id, body_hash: top.body_hash },
        });
      }
    } else {
      out.push({
        source: "pre-commit-tier2-3",
        file: e.file,
        prose: e.block_prose,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Drain pipeline                                                             */
/* -------------------------------------------------------------------------- */

export async function runDrain(args: DrainArgs): Promise<DrainResult> {
  const { repoRoot } = args;
  const dryRun = args.dryRun === true;
  const maxHaikuCalls = args.maxHaikuCalls ?? DEFAULT_MAX_HAIKU_CALLS;
  const sessionId = args.sessionId ?? null;
  const haikuAvailable =
    args.haikuAvailable ?? (args.mockJudge !== undefined ? true : claudeIsAvailable());

  const result: DrainResult = {
    totalEntries: 0,
    droppedMissing: 0,
    citedDeterministic: 0,
    citedHaiku: 0,
    droppedDifferent: 0,
    pending: 0,
    deferred: 0,
    haikuCalls: 0,
    haikuFallback: !haikuAvailable,
  };

  const entries = loadDeferredEntries(repoRoot);
  result.totalEntries = entries.length;
  if (entries.length === 0) return result;

  if (sessionId !== null) {
    pushEvent(repoRoot, sessionId, {
      kind: "drain-progress",
      detail: `${entries.length} entries`,
    });
    if (!haikuAvailable) {
      setHaikuAvailable(repoRoot, sessionId, false);
    }
  }

  const cache = readSotCache(repoRoot);
  const cacheEntries = (Object.values(cache.entries) as SotCacheEntry[]).filter(
    (e) => e.tokens.length > 0,
  );

  const cited: ReplaceItem[] = [];
  const survivingEntries: NormalizedEntry[] = [];

  for (const entry of entries) {
    if (isMarkdownPath(entry.file)) {
      // Drain never auto-cites markdown — same rationale as Layer A/B.
      result.droppedMissing += 1;
      continue;
    }
    const block = relocateBlock(repoRoot, entry);
    if (block === null) {
      result.droppedMissing += 1;
      continue;
    }

    if (entry.source === "pre-commit-tier1" && entry.tier1Candidate !== undefined) {
      const candId = entry.tier1Candidate.id;
      const candBody = readEntityBody(repoRoot, candId);
      if (candBody === null) {
        // Candidate DEC was deleted between defer and drain.
        result.droppedMissing += 1;
        continue;
      }
      // Verify the cached match still holds — body may have changed.
      if (entry.tier1Candidate.body_hash !== bodyContentHash(candBody)) {
        // Cached body diverged; demote to Haiku judge.
        survivingEntries.push({ ...entry, source: "pre-commit-tier2-3" });
        continue;
      }
      cited.push(buildCiteItem(block, candId));
      result.citedDeterministic += 1;
      continue;
    }
    survivingEntries.push(entry);
  }

  if (haikuAvailable) {
    for (const entry of survivingEntries) {
      if (result.haikuCalls >= maxHaikuCalls) {
        result.deferred += 1;
        continue;
      }
      const block = relocateBlock(repoRoot, entry);
      if (block === null) {
        result.droppedMissing += 1;
        continue;
      }
      const blockTokens = tokenize(entry.prose, { codeAware: true });
      const candidates = topKCandidates(
        blockTokens,
        cacheEntries,
        TIER2_JACCARD_FLOOR,
        TOP_K_CANDIDATES,
      );
      if (candidates.length === 0) {
        // Pre-filter found no candidates — fresh creation territory.
        // Drain doesn't run the creation judge (Layer A's surface);
        // drop and let the next Layer A Write trigger creation.
        result.droppedDifferent += 1;
        continue;
      }

      let outcome: { kind: "cite"; id: string } | { kind: "ambiguous"; id: string } | { kind: "no-hit" } = {
        kind: "no-hit",
      };
      for (const cand of candidates) {
        if (result.haikuCalls >= maxHaikuCalls) {
          outcome = { kind: "no-hit" };
          break;
        }
        const candBody = readEntityBody(repoRoot, cand.id);
        if (candBody === null) continue;
        const candScope = `${cand.id}-${bodyContentHash(candBody).slice(0, 12)}`;
        const cached = readVerdictCache(repoRoot, entry.prose, candScope);
        let verdict: DrainJudgeVerdict;
        if (cached !== null) {
          verdict = cached;
        } else {
          if (result.haikuCalls >= maxHaikuCalls) {
            outcome = { kind: "no-hit" };
            break;
          }
          result.haikuCalls += 1;
          verdict = await runDrainJudge({
            blockBody: entry.prose,
            candidate: { id: cand.id, body: candBody },
            mock: args.mockJudge,
          });
          writeVerdictCache(repoRoot, entry.prose, candScope, verdict);
        }
        if (verdict === "same") {
          outcome = { kind: "cite", id: cand.id };
          break;
        }
        if (verdict === "different") continue;
        // ambiguous — surface the highest-scoring ambiguous candidate.
        outcome = { kind: "ambiguous", id: cand.id };
        break;
      }

      if (outcome.kind === "cite") {
        if (!dryRun) cited.push(buildCiteItem(block, outcome.id));
        result.citedHaiku += 1;
        continue;
      }
      if (outcome.kind === "ambiguous") {
        if (!dryRun) {
          const existingBody = readEntityBody(repoRoot, outcome.id);
          writeAlignmentPending({
            repoRoot,
            block,
            kind: "tier2-ambiguous",
            existingId: outcome.id,
            existingBody: existingBody ?? "",
            detector: "layer-c-drain-ambiguous",
          });
        }
        result.pending += 1;
        continue;
      }
      // no-hit — every candidate said `different`.
      result.droppedDifferent += 1;
    }
  } else {
    // Haiku offline — anything that wasn't a deterministic Tier 1
    // hit stays in the deferred log for the next session.
    result.deferred += survivingEntries.length;
  }

  if (cited.length > 0 && !dryRun) {
    applyStripReplace({
      repoRoot,
      items: cited,
    });
  }

  if (!dryRun && haikuAvailable) {
    // Truncate both deferred logs. Drift events in staleness/log.jsonl
    // stay (audit trail). When Haiku is offline we leave the logs alone
    // so the next session retries.
    truncateIfExists(layerADeferredLogPath(repoRoot));
    truncateIfExists(preCommitDeferredLogPath(repoRoot));
  }

  if (sessionId !== null) {
    const totalAligned = result.citedDeterministic + result.citedHaiku;
    const detail =
      totalAligned >= SUMMARY_BLIP_THRESHOLD
        ? `${totalAligned} aligned · ${result.totalEntries} stale entries`
        : `${totalAligned} aligned, ${result.pending} pending, ${result.droppedDifferent + result.droppedMissing} dropped`;
    pushEvent(repoRoot, sessionId, { kind: "drain-done", detail });
  }

  // Audit-trail drift event so a future operator can grep through
  // staleness/log.jsonl and see drains as well as detections.
  recordDriftEvent(repoRoot, {
    ts: new Date().toISOString(),
    kind: "doc-drift",
    path: "(drain)",
    detail: `Layer C drain: cited=${
      result.citedDeterministic + result.citedHaiku
    } pending=${result.pending} dropped=${result.droppedDifferent + result.droppedMissing} deferred=${result.deferred}`,
    severity: "soft",
  });

  return result;
}

/* -------------------------------------------------------------------------- */
/* Block relocation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Re-walk the source file and find the block whose prose still matches
 * the deferred entry. Returns null when the block is gone (operator
 * deleted it, edited it, or Layer A already cited it between defer
 * and drain).
 */
function relocateBlock(repoRoot: string, entry: NormalizedEntry): CommentBlock | null {
  const targetHash = bodyContentHash(entry.prose);
  let blocks: CommentBlock[];
  try {
    blocks = extractBlocks(repoRoot, entry.file);
  } catch {
    return null;
  }
  for (const b of blocks) {
    if (bodyContentHash(b.prose) === targetHash) return b;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Cite builder                                                               */
/* -------------------------------------------------------------------------- */

function buildCiteItem(block: CommentBlock, decId: string): ReplaceItem {
  return {
    blockId: block.id,
    file: block.file,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
    replacement: formatBareCitation(block.lang, decId),
    expectedRaw: block.raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Haiku dedup judge — single-pass (plan §4.3)                                */
/* -------------------------------------------------------------------------- */

const DRAIN_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["same", "different", "ambiguous"] },
  },
} as const;

const DRAIN_JUDGE_SYSTEM = `You compare two prose blocks and return a single verdict.

Reply ONLY the JSON: { "verdict": "same" | "different" | "ambiguous" }.

  - "same"      both blocks describe the same decision/rule (overlap is total)
  - "different" they describe distinct topics
  - "ambiguous" related but not clearly the same — escalate to operator review

Be conservative on "same" — only flag when the two blocks make the same
binding statement with compatible wording.`;

function capBody(body: string): string {
  return body.length > BLOCK_BODY_CAP
    ? `${body.slice(0, BLOCK_BODY_CAP)}\n…[truncated]`
    : body;
}

async function runDrainJudge(args: {
  blockBody: string;
  candidate: { id: string; body: string };
  mock?: DrainArgs["mockJudge"];
}): Promise<DrainJudgeVerdict> {
  if (args.mock !== undefined) {
    return args.mock({ blockBody: args.blockBody, candidate: args.candidate });
  }
  const a = capBody(args.blockBody);
  const b = capBody(args.candidate.body);
  const prompt = [
    "Block A (deferred from a prior write):",
    a,
    "",
    `Block B (existing ${args.candidate.id}):`,
    b,
    "",
    "Are these the same decision/rule?",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: DRAIN_JUDGE_SYSTEM,
      prompt,
      jsonSchema: DRAIN_JUDGE_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) return "ambiguous";
    const v = (parsed as Record<string, unknown>)["verdict"];
    if (v === "same" || v === "different") return v;
    return "ambiguous";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "drain judge failed; treating as ambiguous",
    );
    return "ambiguous";
  }
}

/* -------------------------------------------------------------------------- */
/* Verdict cache                                                              */
/* -------------------------------------------------------------------------- */

function verdictCachePath(repoRoot: string, blockBody: string, scopeKey: string): string {
  const blockHash = createHash("sha256").update(blockBody, "utf8").digest("hex").slice(0, 12);
  return join(haikuCacheDir(repoRoot), "drain-judge", `${blockHash}-${scopeKey}.json`);
}

function readVerdictCache(
  repoRoot: string,
  blockBody: string,
  scopeKey: string,
): DrainJudgeVerdict | null {
  const path = verdictCachePath(repoRoot, blockBody, scopeKey);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { verdict?: unknown };
    const v = parsed.verdict;
    if (v === "same" || v === "different" || v === "ambiguous") return v;
    return null;
  } catch {
    return null;
  }
}

function writeVerdictCache(
  repoRoot: string,
  blockBody: string,
  scopeKey: string,
  verdict: DrainJudgeVerdict,
): void {
  const path = verdictCachePath(repoRoot, blockBody, scopeKey);
  try {
    writeFileSafe(path, JSON.stringify({ verdict }));
  } catch {
    /* best-effort */
  }
}

/* -------------------------------------------------------------------------- */
/* Log truncation                                                             */
/* -------------------------------------------------------------------------- */

function truncateIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
