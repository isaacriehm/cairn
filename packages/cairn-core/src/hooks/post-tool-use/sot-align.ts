/**
 * Layer A — live SoT alignment hook (plan §4.1).
 *
 * `cairn hook sot-align` runs as a PostToolUse hook on Claude Code's
 * Write/Edit. For every prose block in the just-written file the
 * pipeline picks one of:
 *
 *   - **Tier 1 (deterministic, no Haiku)** — block is a verbatim/
 *     near-verbatim duplicate of an existing accepted DEC/INV body
 *     (Jaccard ≥ 0.85, 3-shingle ≥ 60%, length ratio 0.5-2.0).
 *     Auto-replace with `// §DEC-<hash>` (or `# §DEC-<hash>` per
 *     language). Statusline blip `⬡ aligned`.
 *
 *   - **Tier 2 — Haiku dedup judge, two-pass.**
 *       Pass 1 (cheap, snippet + candidate body) → `same | different |
 *       ambiguous`. `same` → cite. `different` → next candidate.
 *       `ambiguous` → escalate to Pass 2.
 *       Pass 2 (full bodies + ±200-char source context + step-by-step
 *       prompt) → `same | different | augments | ambiguous`. `same`
 *       cite; `different` next; `augments` triggers two-stage delta:
 *         - Stage 1 — Haiku extracts the delta prose ("NO_DELTA" → same).
 *         - Stage 2 — Haiku classifies the delta `constraint | rationale`.
 *           constraint → fresh INV linked via `derived_from`; rationale
 *           → fresh DEC linked via `related`. The augmented source
 *           gains a `// §INV-<new>` / `// §DEC-<new>` cite *alongside*
 *           the existing one (existing token preserved).
 *       `ambiguous` (still!) → write to `.cairn/ground/alignment-
 *       pending/<id>.md` and surface via cairn-attention.
 *
 *   - **Tier 3 — Haiku creation judge, two-pass.**
 *       Pass 1 → `decision | constraint | descriptive | ambiguous`.
 *       `descriptive` no-op (false-positive DEC creation pollutes
 *       ground state worse than missed capture). `ambiguous` →
 *       escalate to Pass 2 (full prose + ±200-char context + step-by-
 *       step prompt). Pass-2-still-ambiguous → alignment-pending.
 *
 * Hard rules:
 *   - The hook never blocks the Write. Failures degrade to no-op +
 *     log; the operator's edit always succeeds.
 *   - Per-Write call caps: max HAIKU_PASS1_CAP Pass-1 calls + max
 *     HAIKU_PASS2_CAP Pass-2 calls per Write. Excess defers to
 *     `.cairn/staleness/layer-a-deferred.jsonl` for Layer C drain.
 *   - Verdict cache at `.cairn/cache/haiku/<scope>/<blockHash>-<key>.json`
 *     so re-running the same prose hits cache instead of Haiku.
 *   - Source files outside Claude's repo (cwd) are skipped. Markdown
 *     (`.md`/`.mdx`) skipped entirely — operator-curated narrative is
 *     handled by phase 7's topic-index + the doc-drift sensor.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { readHookStdin } from "../runners/payload.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { runClaude } from "../../claude/index.js";
import { cairnDir,
  anchorMapPath,
  bindDec,
  bodyContentHash,
  type CommentBlock,
  decisionsDir,
  deriveLedgerDecId,
  deriveLedgerInvId,
  emptyAnchorMap,
  invariantsDir,
  isGhost,
  readAnchorMap,
  readScopeIndex,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  recordDriftEvent,
  setAnchor,
  setSotCacheEntry,
  setTopic,
  topicSlug,
  writeAlignmentPending,
  writeAnchorMap,
  writeScopeIndex,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  writeFileSafe,
  type SotCache,
  type SotCacheEntry,
} from "@isaacriehm/cairn-state";
import { writeDecisionsLedger, writeInvariantsLedger } from "@isaacriehm/cairn-state";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "../../init/source-comments/strip-replace.js";
import {
  appendAlignUndoEntry,
  type AlignUndoEntry,
} from "../../align-undo/index.js";
import { logger } from "../../logger.js";
import { tokenize } from "../../text/jaccard.js";
import { withWriteLock } from "../../lock.js";
import { pushEvent } from "../../status-line/event-queue.js";
import {
  TIER2_JACCARD_FLOOR,
  TOP_K_CANDIDATES,
  containsEssayClassShape,
  extractBlocks,
  isMarkdownPath,
  readEntityBody,
  tier1PickWithBody,
  topKCandidates,
  type Candidate,
} from "../sot-align-common.js";

const log = logger("hooks.post-tool-use.sot-align");


const VerdictCacheSchema = z.object({
  verdict: z.string(),
  ts: z.string().optional(),
}).passthrough();

const ClaudePostToolUsePayloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.object({
    file_path: z.string().optional(),
    // Edit tool — old/new strings let the diff-aware short-circuit
    // detect whether the edit touched essay-class prose.
    new_string: z.string().optional(),
    old_string: z.string().optional(),
    // Write tool — full file content. Same purpose.
    content: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudePostToolUsePayload = z.infer<typeof ClaudePostToolUsePayloadSchema>;

const CAPTURE_SOURCE = "layer-a-sot-align";

/* -------------------------------------------------------------------------- */
/* Tunables — Layer A only (shared Tier 1/2 floors live in sot-align-common)  */
/* -------------------------------------------------------------------------- */

const HAIKU_PASS1_CAP = 5;
const HAIKU_PASS2_CAP = 2;
const PER_HAIKU_TIMEOUT_MS = 30_000;
const BLOCK_BODY_CAP = 1_500;
const SOURCE_CONTEXT_RADIUS = 200;

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface AlignFileArgs {
  repoRoot: string;
  /** Repo-relative POSIX path written by Claude Code. */
  filePath: string;
  /** Claude Code session id (for statusline blips). */
  sessionId: string | null;
  /**
   * Mock dedup judge — Pass 1. Default uses Haiku via runClaude.
   */
  mockDedupJudgePass1?: (args: {
    blockBody: string;
    candidate: { id: string; body: string };
  }) => Promise<DedupVerdictPass1>;
  /**
   * Mock dedup judge — Pass 2 (CoT escalation). Default uses Haiku.
   */
  mockDedupJudgePass2?: (args: {
    blockBody: string;
    blockContext: string;
    candidate: { id: string; body: string };
  }) => Promise<DedupVerdictPass2>;
  /**
   * Mock delta extractor (Stage 1) — extract the prose delta when
   * Pass 2 returns `augments`. Default uses Haiku.
   */
  mockDeltaExtract?: (args: {
    blockBody: string;
    candidateBody: string;
  }) => Promise<string>;
  /**
   * Mock delta classifier (Stage 2) — `constraint | rationale`.
   * Default uses Haiku.
   */
  mockDeltaClassify?: (args: { delta: string }) => Promise<DeltaKind>;
  /**
   * Mock creation judge — Pass 1. Default uses Haiku via runClaude.
   */
  mockCreationJudgePass1?: (args: {
    blockBody: string;
    file: string;
    line: number;
  }) => Promise<CreationVerdict>;
  /**
   * Mock creation judge — Pass 2 (CoT escalation). Default uses Haiku.
   */
  mockCreationJudgePass2?: (args: {
    blockBody: string;
    blockContext: string;
    file: string;
    line: number;
  }) => Promise<CreationVerdict>;
  /**
   * Override the per-call Pass-1 Haiku cap. Default 5 — appropriate
   * for live PostToolUse Writes where the cost has to stay tight.
   * Layer D (`cairn fix align`) sets this much higher (e.g. 200) so a
   * single-file sweep can fully judge every block.
   */
  pass1Cap?: number;
  /** Override the per-call Pass-2 Haiku cap. Default 2. */
  pass2Cap?: number;
  /**
   * When true, suppress the Tier 3 creation pipeline entirely — Tier 1
   * + Tier 2 dedup still run. Layer D's `--no-creation` flag sets this
   * so a sweep only consolidates duplicates without proposing fresh
   * DECs from prose that doesn't match anything in the ledger yet.
   */
  skipCreation?: boolean;
}

type DedupVerdictPass1 = "same" | "different" | "ambiguous";
type DedupVerdictPass2 = "same" | "different" | "augments" | "ambiguous";
type DeltaKind = "constraint" | "rationale";
export type CreationVerdict = "decision" | "constraint" | "descriptive" | "ambiguous";

/** Back-compat alias preserved for external callers. */
export type DedupVerdict = DedupVerdictPass1;

export interface AlignFileResult {
  /** Number of prose blocks discovered in the written file. */
  blocksConsidered: number;
  /** Tier 1 deterministic auto-cites. */
  tier1Aligned: number;
  /** Tier 2 Haiku-confirmed cites. */
  tier2Aligned: number;
  /** Tier 3 fresh DECs emitted. */
  decsCreated: number;
  /** Tier 3 fresh INVs emitted. */
  invsCreated: number;
  /** Augments-DEC siblings (Pass 2 delta = rationale). */
  augmentsDecs: number;
  /** Augments-INV siblings (Pass 2 delta = constraint). */
  augmentsInvs: number;
  /** Blocks queued in `.cairn/ground/alignment-pending/`. */
  pending: number;
  /** Blocks deferred to staleness (cap exceeded). */
  deferredToStaleness: number;
  /** Blocks classified as descriptive (no-op). */
  descriptive: number;
  /** Blocks skipped for any reason — already-cited, length floor, etc. */
  skipped: number;
  /** Pass-1 Haiku calls made. */
  haikuPass1Calls: number;
  /** Pass-2 Haiku calls made. */
  haikuPass2Calls: number;
  /** Total Haiku calls (Pass 1 + Pass 2 + augments stages). Back-compat. */
  haikuCalls: number;
}

/**
 * Run the Layer A pipeline against one repo-relative file.
 */
export async function alignFile(args: AlignFileArgs): Promise<AlignFileResult> {
  const { repoRoot, filePath, sessionId } = args;
  const result: AlignFileResult = {
    blocksConsidered: 0,
    tier1Aligned: 0,
    tier2Aligned: 0,
    decsCreated: 0,
    invsCreated: 0,
    augmentsDecs: 0,
    augmentsInvs: 0,
    pending: 0,
    deferredToStaleness: 0,
    descriptive: 0,
    skipped: 0,
    haikuPass1Calls: 0,
    haikuPass2Calls: 0,
    haikuCalls: 0,
  };

  // Plan §3.1 — markdown narrative (docs/, CLAUDE.md, AGENTS.md, rules)
  // is operator-curated. Phase 7's topic-index + the doc-drift sensor
  // handle cross-source dedup there. Layer A only acts on code paths
  // where strip-replace + bare `// §DEC-<hash>` cites are the right
  // surface. Skipping markdown also avoids polluting docs with a
  // `// §DEC-<hash>` line that isn't valid markdown syntax.
  if (isMarkdownPath(filePath)) {
    return result;
  }

  const blocks = extractBlocks(repoRoot, filePath);
  result.blocksConsidered = blocks.length;
  if (blocks.length === 0) return result;

  const cache = readSotCache(repoRoot);
  const cacheEntries = Object.values(cache.entries)
    .filter((e): e is SotCacheEntry => e !== undefined && e.tokens.length > 0);

  const stripItems: ReplaceItem[] = [];
  // `undoLogEntries` shadows `stripItems` 1:1 — each push to one
  // pushes to the other. After applyStripReplace succeeds we write
  // these to `.cairn/state/align-undo-log.jsonl` for `cairn attention
  // undo` (plan §11.7).
  const undoLogEntries: AlignUndoEntry[] = [];
  let pass1Calls = 0;
  let pass2Calls = 0;
  let auxiliaryCalls = 0; // delta extraction + classification
  const pass1Cap = args.pass1Cap ?? HAIKU_PASS1_CAP;
  const pass2Cap = args.pass2Cap ?? HAIKU_PASS2_CAP;
  const skipCreation = args.skipCreation === true;

  const fileSource = readFileMaybe(repoRoot, filePath);

  // After every Tier-3 / augments emit we append the fresh entry to
  // `cacheEntries` so a later block in the same Write that mirrors the
  // just-emitted prose flows through Tier 1 / Tier 2 instead of
  // emitting a second duplicate DEC. Without this, two similar JSDoc
  // blocks in the same file would each become their own ledger DEC.
  const recordFreshEntry = (id: string, body: string): void => {
    cacheEntries.push({
      dec_id: id,
      sot_path: "ledger",
      body_hash: bodyContentHash(body),
      tokens: Array.from(tokenize(body, { codeAware: true })),
      shingles: [],
      mtime_ms: Date.now(),
    });
  };

  for (const block of blocks) {
    if (block.prose.length < 80) {
      result.skipped += 1;
      continue;
    }
    const blockTokens = tokenize(block.prose, { codeAware: true });
    if (blockTokens.size < 10) {
      result.skipped += 1;
      continue;
    }

    const candidates = topKCandidates(blockTokens, cacheEntries, TIER2_JACCARD_FLOOR, TOP_K_CANDIDATES);

    // Tier 1 — deterministic shortcut.
    const tier1Match = tier1PickWithBody(repoRoot, block, candidates);
    if (tier1Match !== null) {
      const item = buildCiteItem(block, tier1Match.id);
      stripItems.push(item);
      undoLogEntries.push(makeUndoEntry({
        sessionId,
        kind: "tier1-cite",
        block,
        item,
        primaryId: tier1Match.id,
      }));
      pushAlignBlip(repoRoot, sessionId, tier1Match.id, "aligned");
      result.tier1Aligned += 1;
      continue;
    }

    // Tier 2 — Haiku dedup judge, two-pass.
    type Tier2Outcome =
      | { kind: "cite"; id: string }
      | {
          kind: "augments";
          existingId: string;
          existingBody: string;
          existingKind: "DEC" | "INV";
          /** Body-hash-versioned scope key for the augments-stage verdict cache. */
          candScope: string;
        }
      | { kind: "deferred-cap" }
      | { kind: "deferred-pending"; existingId: string }
      | { kind: "no-hit" };
    let tier2Outcome: Tier2Outcome = { kind: "no-hit" };
    if (candidates.length > 0) {
      candidateLoop: for (const cand of candidates) {
        const candBody = readEntityBody(repoRoot, cand.id);
        if (candBody === null) continue;
        // Verdict cache scoped on (block prose, candidate id, fresh body
        // hash). The hash is computed from `candBody` we just read off
        // disk rather than the sot-cache snapshot in `cand.body_hash` —
        // the operator can edit DEC bodies between sot-cache refreshes,
        // and a stale "same" verdict against an old body would let us
        // cite a now-different DEC.
        const candScope = `${cand.id}-${bodyContentHash(candBody).slice(0, 12)}`;

        // Pass 1.
        const cachedP1 = readVerdictCache(repoRoot, "dedup-p1", block.prose, candScope);
        let p1: DedupVerdictPass1;
        if (
          cachedP1 === "same" ||
          cachedP1 === "different" ||
          cachedP1 === "ambiguous"
        ) {
          p1 = cachedP1;
        } else {
          // Cap check fires only when we'd actually make a fresh call —
          // cache hits at cap still return their cached verdict (free).
          if (pass1Calls >= pass1Cap) {
            tier2Outcome = { kind: "deferred-cap" };
            break;
          }
          pass1Calls += 1;
          p1 = await runDedupJudgePass1({
            blockBody: block.prose,
            candidate: { id: cand.id, body: candBody },
            mock: args.mockDedupJudgePass1,
          });
          writeVerdictCache(repoRoot, "dedup-p1", block.prose, candScope, p1);
        }
        if (p1 === "same") {
          tier2Outcome = { kind: "cite", id: cand.id };
          break;
        }
        if (p1 === "different") continue;

        // Pass 1 ambiguous → escalate to Pass 2.
        const cachedP2 = readVerdictCache(repoRoot, "dedup-p2", block.prose, candScope);
        let p2: DedupVerdictPass2;
        if (
          cachedP2 === "same" ||
          cachedP2 === "different" ||
          cachedP2 === "augments" ||
          cachedP2 === "ambiguous"
        ) {
          p2 = cachedP2;
        } else {
          if (pass2Calls >= pass2Cap) {
            tier2Outcome = { kind: "deferred-cap" };
            break;
          }
          pass2Calls += 1;
          p2 = await runDedupJudgePass2({
            blockBody: block.prose,
            blockContext: surroundingContext(fileSource, block.startOffset, block.endOffset),
            candidate: { id: cand.id, body: candBody },
            mock: args.mockDedupJudgePass2,
          });
          writeVerdictCache(repoRoot, "dedup-p2", block.prose, candScope, p2);
        }
        if (p2 === "same") {
          tier2Outcome = { kind: "cite", id: cand.id };
          break;
        }
        if (p2 === "different") continue;
        if (p2 === "augments") {
          tier2Outcome = {
            kind: "augments",
            existingId: cand.id,
            existingBody: candBody,
            existingKind: cand.id.startsWith("INV-") ? "INV" : "DEC",
            candScope,
          };
          break candidateLoop;
        }
        // p2 === "ambiguous" — alignment-pending surface.
        tier2Outcome = { kind: "deferred-pending", existingId: cand.id };
        break;
      }
    }

    if (tier2Outcome.kind === "deferred-cap") {
      deferToStaleness(repoRoot, block, "tier2-cap-exceeded");
      result.deferredToStaleness += 1;
      continue;
    }
    if (tier2Outcome.kind === "cite") {
      const item = buildCiteItem(block, tier2Outcome.id);
      stripItems.push(item);
      undoLogEntries.push(makeUndoEntry({
        sessionId,
        kind: "tier2-cite",
        block,
        item,
        primaryId: tier2Outcome.id,
      }));
      pushAlignBlip(repoRoot, sessionId, tier2Outcome.id, "aligned");
      result.tier2Aligned += 1;
      continue;
    }
    if (tier2Outcome.kind === "deferred-pending") {
      writeAlignmentPending({
        repoRoot,
        block,
        kind: "tier2-ambiguous",
        existingId: tier2Outcome.existingId,
        existingBody: readEntityBody(repoRoot, tier2Outcome.existingId) ?? "",
      });
      result.pending += 1;
      continue;
    }
    if (tier2Outcome.kind === "augments") {
      // Stage 1 — extract delta. Stage 2 — classify constraint vs rationale.
      // Cache scope = (block, candidate-id-with-body-hash) so a refreshed
      // candidate body forces a fresh extraction instead of reusing a
      // delta computed against the prior body.
      const cachedDelta = readVerdictCache(
        repoRoot,
        "delta-extract",
        block.prose,
        tier2Outcome.candScope,
      );
      let delta: string;
      if (cachedDelta !== null) {
        delta = cachedDelta;
      } else {
        auxiliaryCalls += 1;
        delta = await runDeltaExtract({
          blockBody: block.prose,
          candidateBody: tier2Outcome.existingBody,
          mock: args.mockDeltaExtract,
        });
        writeVerdictCache(
          repoRoot,
          "delta-extract",
          block.prose,
          tier2Outcome.candScope,
          delta,
        );
      }
      if (delta.trim() === "NO_DELTA" || delta.trim().length === 0) {
        // Pass-2 said augments but Stage 1 found nothing — treat as same.
        const item = buildCiteItem(block, tier2Outcome.existingId);
        stripItems.push(item);
        undoLogEntries.push(makeUndoEntry({
          sessionId,
          kind: "tier2-cite",
          block,
          item,
          primaryId: tier2Outcome.existingId,
        }));
        pushAlignBlip(repoRoot, sessionId, tier2Outcome.existingId, "aligned");
        result.tier2Aligned += 1;
        continue;
      }
      const cachedKind = readVerdictCache(
        repoRoot,
        "delta-classify",
        delta,
        tier2Outcome.candScope,
      );
      let deltaKind: DeltaKind;
      if (cachedKind === "constraint" || cachedKind === "rationale") {
        deltaKind = cachedKind;
      } else {
        auxiliaryCalls += 1;
        deltaKind = await runDeltaClassify({
          delta,
          mock: args.mockDeltaClassify,
        });
        writeVerdictCache(
          repoRoot,
          "delta-classify",
          delta,
          tier2Outcome.candScope,
          deltaKind,
        );
      }
      const augEmit = await emitAugmentSibling({
        repoRoot,
        block,
        delta,
        deltaKind,
        existingId: tier2Outcome.existingId,
      });
      if (augEmit === null) {
        result.skipped += 1;
        continue;
      }
      // Existing § token preserved; add the new sibling cite alongside.
      const augItem = buildAugmentCiteItem(block, tier2Outcome.existingId, augEmit.id);
      stripItems.push(augItem);
      undoLogEntries.push(makeUndoEntry({
        sessionId,
        kind: "augments",
        block,
        item: augItem,
        primaryId: augEmit.id,
        primaryKind: augEmit.kind,
        augmentsExistingId: tier2Outcome.existingId,
      }));
      recordFreshEntry(augEmit.id, delta);
      if (augEmit.kind === "INV") {
        result.augmentsInvs += 1;
        pushAlignBlip(repoRoot, sessionId, tier2Outcome.existingId, "constrained");
      } else {
        result.augmentsDecs += 1;
        pushAlignBlip(repoRoot, sessionId, tier2Outcome.existingId, "supplemented");
      }
      continue;
    }

    // Tier 3 — creation judge, two-pass.
    if (skipCreation) {
      // `cairn fix align --no-creation` — the operator wants
      // duplicate consolidation only, not fresh DEC creation. Treat
      // the block as descriptive without invoking Haiku.
      result.descriptive += 1;
      continue;
    }
    const cachedT3P1 = readVerdictCache(repoRoot, "create-p1", block.prose, "creation");
    let creationP1: CreationVerdict;
    if (
      cachedT3P1 === "decision" ||
      cachedT3P1 === "constraint" ||
      cachedT3P1 === "descriptive" ||
      cachedT3P1 === "ambiguous"
    ) {
      creationP1 = cachedT3P1;
    } else {
      if (pass1Calls >= pass1Cap) {
        deferToStaleness(repoRoot, block, "tier3-cap-exceeded");
        result.deferredToStaleness += 1;
        continue;
      }
      pass1Calls += 1;
      creationP1 = await runCreationJudgePass1({
        blockBody: block.prose,
        file: block.file,
        line: block.startLine,
        mock: args.mockCreationJudgePass1,
      });
      writeVerdictCache(repoRoot, "create-p1", block.prose, "creation", creationP1);
    }

    let creationVerdict: CreationVerdict = creationP1;
    if (creationVerdict === "ambiguous") {
      const cachedT3P2 = readVerdictCache(repoRoot, "create-p2", block.prose, "creation");
      let creationP2: CreationVerdict;
      if (
        cachedT3P2 === "decision" ||
        cachedT3P2 === "constraint" ||
        cachedT3P2 === "descriptive" ||
        cachedT3P2 === "ambiguous"
      ) {
        creationP2 = cachedT3P2;
      } else {
        if (pass2Calls >= pass2Cap) {
          deferToStaleness(repoRoot, block, "tier3-pass2-cap-exceeded");
          result.deferredToStaleness += 1;
          continue;
        }
        pass2Calls += 1;
        creationP2 = await runCreationJudgePass2({
          blockBody: block.prose,
          blockContext: surroundingContext(fileSource, block.startOffset, block.endOffset),
          file: block.file,
          line: block.startLine,
          mock: args.mockCreationJudgePass2,
        });
        writeVerdictCache(repoRoot, "create-p2", block.prose, "creation", creationP2);
      }
      creationVerdict = creationP2;
    }

    if (creationVerdict === "descriptive") {
      result.descriptive += 1;
      continue;
    }
    if (creationVerdict === "ambiguous") {
      writeAlignmentPending({
        repoRoot,
        block,
        kind: "tier3-ambiguous",
      });
      result.pending += 1;
      continue;
    }

    // creationVerdict === "decision" | "constraint" → emit ledger entity.
    const emit = await emitLedgerEntity({
      repoRoot,
      block,
      kind: creationVerdict,
    });
    if (emit === null) {
      result.skipped += 1;
      continue;
    }
    const createItem = buildCiteItem(block, emit.id);
    stripItems.push(createItem);
    undoLogEntries.push(makeUndoEntry({
      sessionId,
      kind: "tier3-creation",
      block,
      item: createItem,
      primaryId: emit.id,
      primaryKind: emit.kind,
    }));
    recordFreshEntry(emit.id, block.prose);
    if (emit.kind === "DEC") {
      result.decsCreated += 1;
      pushAlignBlip(repoRoot, sessionId, emit.id, "created-dec");
    } else {
      result.invsCreated += 1;
      pushAlignBlip(repoRoot, sessionId, emit.id, "created-inv");
    }
  }

  result.haikuPass1Calls = pass1Calls;
  result.haikuPass2Calls = pass2Calls;
  result.haikuCalls = pass1Calls + pass2Calls + auxiliaryCalls;

  if (stripItems.length > 0) {
    try {
      const dirtyDecisions: Record<string, "overwrite"> = {};
      for (const it of stripItems) dirtyDecisions[it.file] = "overwrite";
      await withWriteLock(repoRoot, () => {
        applyStripReplace({ repoRoot, items: stripItems, dirtyDecisions });
      });
      // strip-replace landed — append undo records so `cairn attention
      // undo` can roll back the cite, fresh DEC creation, or augments
      // sibling. We log AFTER the write so an aborted apply doesn't
      // leave a misleading audit trail.
      for (const u of undoLogEntries) await appendAlignUndoEntry(repoRoot, u);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Layer A strip-replace failed",
      );
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Align-undo entry builder                                                   */
/* -------------------------------------------------------------------------- */

function makeUndoEntry(args: {
  sessionId: string | null;
  kind: AlignUndoEntry["kind"];
  block: CommentBlock;
  item: ReplaceItem;
  primaryId: string;
  primaryKind?: "DEC" | "INV";
  augmentsExistingId?: string;
}): AlignUndoEntry {
  const entry: AlignUndoEntry = {
    ts: new Date().toISOString(),
    session_id: args.sessionId,
    kind: args.kind,
    file: args.item.file,
    start_offset: args.item.startOffset,
    end_offset: args.item.endOffset,
    original_raw: args.item.expectedRaw ?? args.block.raw,
    replacement: args.item.replacement,
    primary_id: args.primaryId,
  };
  if (args.primaryKind !== undefined) entry.primary_kind = args.primaryKind;
  if (args.augmentsExistingId !== undefined)
    entry.augments_existing_id = args.augmentsExistingId;
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Block extraction                                                           */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Strip-replace item builder                                                 */
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
/* Haiku dedup judge — Pass 1                                                 */
/* -------------------------------------------------------------------------- */

const DEDUP_P1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["same", "different", "ambiguous"] },
  },
} as const;

const DEDUP_P1_SYSTEM = `You compare two prose blocks and return a single verdict.

Reply ONLY the JSON: { "verdict": "same" | "different" | "ambiguous" }.

  - "same"      both blocks describe the same decision/rule (overlap is total)
  - "different" they describe distinct topics
  - "ambiguous" related but not clearly the same — escalate

Be conservative on "same" — only flag when the two blocks make the same
binding statement with compatible wording.`;

const DedupP1Schema = z.object({
  verdict: z.enum(["same", "different", "ambiguous"]),
});

const DedupP2Schema = z.object({
  verdict: z.enum(["same", "different", "augments", "ambiguous"]),
  reasoning: z.string().optional(),
});

const DeltaExtractSchema = z.object({
  delta: z.string(),
});

const DeltaClassifySchema = z.object({
  kind: z.enum(["constraint", "rationale"]),
});

const CreationVerdictSchema = z.object({
  verdict: z.enum(["decision", "constraint", "descriptive", "ambiguous"]),
});

async function runDedupJudgePass1(args: {
  blockBody: string;
  candidate: { id: string; body: string };
  mock?: AlignFileArgs["mockDedupJudgePass1"];
}): Promise<DedupVerdictPass1> {
  if (args.mock !== undefined) {
    return args.mock({ blockBody: args.blockBody, candidate: args.candidate });
  }
  const a = capBody(args.blockBody);
  const b = capBody(args.candidate.body);
  const prompt = [
    "Block A (just written):",
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
      system: DEDUP_P1_SYSTEM,
      prompt,
      jsonSchema: DEDUP_P1_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = DedupP1Schema.safeParse(result.parsed);
    if (!parsed.success) return "ambiguous";
    return parsed.data.verdict;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "dedup judge pass-1 failed; treating as ambiguous",
    );
    return "ambiguous";
  }
}

/* -------------------------------------------------------------------------- */
/* Haiku dedup judge — Pass 2 (CoT)                                           */
/* -------------------------------------------------------------------------- */

const DEDUP_P2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: {
      type: "string",
      enum: ["same", "different", "augments", "ambiguous"],
    },
    reasoning: { type: "string" },
  },
} as const;

const DEDUP_P2_SYSTEM = `You compare two prose blocks for whether they describe the same decision/rule.

Use step-by-step reasoning:
  Step 1: list the specific facts in Block A.
  Step 2: list the specific facts in Block B.
  Step 3: do these capture the SAME decision, or do they differ?

Final verdict (return JSON):
  - "same"      both blocks make the same binding statement
  - "different" they describe distinct topics
  - "augments"  same topic, but A adds rationale/context that B doesn't have
  - "ambiguous" cannot tell

Be conservative on "same"/"augments" — when in doubt, prefer "ambiguous".`;

async function runDedupJudgePass2(args: {
  blockBody: string;
  blockContext: string;
  candidate: { id: string; body: string };
  mock?: AlignFileArgs["mockDedupJudgePass2"];
}): Promise<DedupVerdictPass2> {
  if (args.mock !== undefined) {
    return args.mock({
      blockBody: args.blockBody,
      blockContext: args.blockContext,
      candidate: args.candidate,
    });
  }
  const a = capBody(args.blockBody);
  const b = capBody(args.candidate.body);
  const ctx = args.blockContext.trim();
  const prompt = [
    "Block A (just written):",
    a,
    "",
    "---surrounding source context---",
    ctx.length > 0 ? ctx : "(no surrounding context available)",
    "",
    `Block B (existing ${args.candidate.id}, full body):`,
    b,
    "",
    "Step 1: list specific facts in A.",
    "Step 2: list specific facts in B.",
    "Step 3: do these capture the SAME decision, or do they differ?",
    "",
    "Final verdict: same | different | augments | ambiguous.",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: DEDUP_P2_SYSTEM,
      prompt,
      jsonSchema: DEDUP_P2_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = DedupP2Schema.safeParse(result.parsed);
    if (!parsed.success) return "ambiguous";
    return parsed.data.verdict;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "dedup judge pass-2 failed; treating as ambiguous",
    );
    return "ambiguous";
  }
}

/* -------------------------------------------------------------------------- */
/* Augments delta extraction (Stage 1) + classification (Stage 2)             */
/* -------------------------------------------------------------------------- */

const DELTA_EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["delta"],
  properties: { delta: { type: "string" } },
} as const;

const DELTA_EXTRACT_SYSTEM = `You extract the delta — the new content in Block A that is not present in Block B.

Output JSON: { "delta": "<text>" }.
  - If A says everything B says PLUS something new, return ONLY the new content verbatim.
  - If A and B fully overlap (no real delta), return the literal string "NO_DELTA".
  - Do not summarize. Do not paraphrase. Verbatim or NO_DELTA.`;

async function runDeltaExtract(args: {
  blockBody: string;
  candidateBody: string;
  mock?: AlignFileArgs["mockDeltaExtract"];
}): Promise<string> {
  if (args.mock !== undefined) {
    return args.mock({
      blockBody: args.blockBody,
      candidateBody: args.candidateBody,
    });
  }
  const a = capBody(args.blockBody);
  const b = capBody(args.candidateBody);
  const prompt = [
    "Block A (just written):",
    a,
    "",
    "Block B (existing DEC body):",
    b,
    "",
    "Extract ONLY the new content from A that is not present in B.",
    "Output exactly the delta text, no summary. If overlap is total, output \"NO_DELTA\".",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: DELTA_EXTRACT_SYSTEM,
      prompt,
      jsonSchema: DELTA_EXTRACT_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = DeltaExtractSchema.safeParse(result.parsed);
    if (!parsed.success) return "NO_DELTA";
    return parsed.data.delta;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "delta extract failed; treating as NO_DELTA",
    );
    return "NO_DELTA";
  }
}

const DELTA_CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["constraint", "rationale"] },
  },
} as const;

const DELTA_CLASSIFY_SYSTEM = `You classify a delta as either a CONSTRAINT or SUPPLEMENTAL RATIONALE.

  - "constraint" the delta states a hard rule (must / must not / never / always / required / forbidden).
  - "rationale"  the delta is additional context / motivation for an existing decision.

Reply ONLY: { "kind": "constraint" | "rationale" }.`;

async function runDeltaClassify(args: {
  delta: string;
  mock?: AlignFileArgs["mockDeltaClassify"];
}): Promise<DeltaKind> {
  if (args.mock !== undefined) {
    return args.mock({ delta: args.delta });
  }
  const d = capBody(args.delta);
  const prompt = [
    "Delta:",
    d,
    "",
    "Is this a CONSTRAINT (must / must not / never) or SUPPLEMENTAL RATIONALE?",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: DELTA_CLASSIFY_SYSTEM,
      prompt,
      jsonSchema: DELTA_CLASSIFY_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = DeltaClassifySchema.safeParse(result.parsed);
    if (!parsed.success) return "rationale";
    return parsed.data.kind;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "delta classify failed; treating as rationale",
    );
    return "rationale";
  }
}

/* -------------------------------------------------------------------------- */
/* Haiku creation judge — Pass 1                                              */
/* -------------------------------------------------------------------------- */

const CREATION_P1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: {
      type: "string",
      enum: ["decision", "constraint", "descriptive", "ambiguous"],
    },
  },
} as const;

const CREATION_P1_SYSTEM = `You classify a single prose block as one of:

  - "decision"    contains an explicit decision verb (chose, selected, picked,
                  decided) AND a comparative/rationale clause (over X, because Y).
  - "constraint"  contains an explicit constraint verb (must, must not, never,
                  always, required, forbidden).
  - "descriptive" explains what the code does, intent, behavior notes.
                  No decision verb, no constraint verb.
  - "ambiguous"   cannot tell.

Default to "descriptive" when uncertain — false-positive DEC creation
pollutes the ground state worse than missed capture.

Reply ONLY: { "verdict": "decision" | "constraint" | "descriptive" | "ambiguous" }`;

async function runCreationJudgePass1(args: {
  blockBody: string;
  file: string;
  line: number;
  mock?: AlignFileArgs["mockCreationJudgePass1"];
}): Promise<CreationVerdict> {
  if (args.mock !== undefined) {
    return args.mock({ blockBody: args.blockBody, file: args.file, line: args.line });
  }
  const a = capBody(args.blockBody);
  const prompt = [`Block at ${args.file}:${args.line}:`, a].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: CREATION_P1_SYSTEM,
      prompt,
      jsonSchema: CREATION_P1_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) return "descriptive";
    const v = (parsed as { verdict?: unknown }).verdict;
    if (
      v === "decision" ||
      v === "constraint" ||
      v === "descriptive" ||
      v === "ambiguous"
    ) {
      return v;
    }
    return "descriptive";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "creation judge pass-1 failed; treating as descriptive",
    );
    return "descriptive";
  }
}

/* -------------------------------------------------------------------------- */
/* Haiku creation judge — Pass 2 (CoT)                                        */
/* -------------------------------------------------------------------------- */

const CREATION_P2_SCHEMA = CREATION_P1_SCHEMA;

const CREATION_P2_SYSTEM = `You classify a prose block, using step-by-step reasoning before the verdict.

Step 1: list explicit decision/constraint verbs in the block.
Step 2: does the block describe a CHOICE the codebase made (decision),
        a RULE the code must obey (constraint), or just describe what
        the code does (descriptive)?
Step 3: default to descriptive when in doubt — false-positive DEC creation
        pollutes ground state worse than missed capture.

Final verdict JSON: { "verdict": "decision" | "constraint" | "descriptive" | "ambiguous" }.`;

async function runCreationJudgePass2(args: {
  blockBody: string;
  blockContext: string;
  file: string;
  line: number;
  mock?: AlignFileArgs["mockCreationJudgePass2"];
}): Promise<CreationVerdict> {
  if (args.mock !== undefined) {
    return args.mock({
      blockBody: args.blockBody,
      blockContext: args.blockContext,
      file: args.file,
      line: args.line,
    });
  }
  const a = capBody(args.blockBody);
  const ctx = args.blockContext.trim();
  const prompt = [
    `Block at ${args.file}:${args.line}:`,
    a,
    "",
    "---surrounding source context---",
    ctx.length > 0 ? ctx : "(no surrounding context available)",
    "",
    "Step 1: list explicit decision/constraint verbs in the block.",
    "Step 2: choice / rule / descriptive?",
    "Step 3: default to descriptive when in doubt.",
    "",
    "Final verdict: decision | constraint | descriptive | ambiguous.",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: CREATION_P2_SYSTEM,
      prompt,
      jsonSchema: CREATION_P2_SCHEMA,
      timeoutMs: PER_HAIKU_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) return "descriptive";
    const v = (parsed as { verdict?: unknown }).verdict;
    if (
      v === "decision" ||
      v === "constraint" ||
      v === "descriptive" ||
      v === "ambiguous"
    ) {
      return v;
    }
    return "descriptive";
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "creation judge pass-2 failed; treating as descriptive",
    );
    return "descriptive";
  }
}

function capBody(body: string): string {
  return body.length > BLOCK_BODY_CAP
    ? `${body.slice(0, BLOCK_BODY_CAP)}\n…[truncated]`
    : body;
}

function readFileMaybe(repoRoot: string, filePath: string): string {
  const abs = join(repoRoot, filePath);
  if (!existsSync(abs)) return "";
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function surroundingContext(
  fileSource: string,
  startOffset: number,
  endOffset: number,
): string {
  if (fileSource.length === 0) return "";
  const ctxStart = Math.max(0, startOffset - SOURCE_CONTEXT_RADIUS);
  const ctxEnd = Math.min(fileSource.length, endOffset + SOURCE_CONTEXT_RADIUS);
  return fileSource.slice(ctxStart, ctxEnd);
}

/* -------------------------------------------------------------------------- */
/* Ledger emit (Tier 3 decision/constraint)                                   */
/* -------------------------------------------------------------------------- */

interface EmitResult {
  id: string;
  kind: "DEC" | "INV";
}

/**
 * Ghost: record the `file → entity` binding in the out-of-repo scope-index at
 * emit time. Committed mode derives this binding later from the in-source `§`
 * cite, but ghost writes no cite (applyStripReplace no-ops), so emit is the only
 * chance to record it — GC liveness (entity-orphan) and read-enricher recall
 * both read this binding. No-op outside ghost. Caller holds the write lock.
 */
function bindGhostScope(
  repoRoot: string,
  file: string,
  id: string,
  isDec: boolean,
): void {
  if (!isGhost(repoRoot)) return;
  const idx = readScopeIndex(repoRoot) ?? {
    generated: new Date().toISOString(),
    files: {},
  };
  const entry = idx.files[file] ?? { decisions: [], invariants: [] };
  const list = isDec ? entry.decisions : entry.invariants;
  if (!list.includes(id)) list.push(id);
  idx.files[file] = entry;
  idx.generated = new Date().toISOString();
  writeScopeIndex(repoRoot, idx);
}

async function emitLedgerEntity(args: {
  repoRoot: string;
  block: CommentBlock;
  kind: "decision" | "constraint";
}): Promise<EmitResult | null> {
  const { repoRoot, block, kind } = args;
  const isDec = kind === "decision";
  const inputs = {
    source_file: block.file,
    source_offset: block.startLine,
    capture_source: CAPTURE_SOURCE,
  };
  const id = isDec ? deriveLedgerDecId(inputs) : deriveLedgerInvId(inputs);
  const now = new Date().toISOString();
  const title = firstLine(block.prose);
  const fm: Record<string, unknown> = {
    id,
    title,
    type: isDec ? "adr" : "invariant",
    status: isDec ? "accepted" : "active",
    audience: "dual",
    generated: now,
    "verified-at": now,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(block.prose),
    capture_source: CAPTURE_SOURCE,
    source_file: block.file,
  };
  if (isDec) {
    fm["decided_at"] = now;
    fm["decided_by"] = "cairn-layer-a";
  }
  const dir = isDec ? decisionsDir(repoRoot) : invariantsDir(repoRoot);
  const abs = join(dir, `${id}.md`);
  if (existsSync(abs)) {
    // Idempotent — same source location keeps producing the same id.
    return { id, kind: isDec ? "DEC" : "INV" };
  }
  try {
    await withWriteLock(repoRoot, () => {
      mkdirSync(dir, { recursive: true });
      const out = `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${block.prose.trim()}\n`;
      writeFileSync(abs, out, "utf8");
      // Bind sot-path → id + cache tokens for future Layer A passes.
      const bindings = readSotBindings(repoRoot);
      const updatedBindings = bindDec(bindings, id, "ledger");
      updatedBindings.generated = new Date().toISOString();
      writeSotBindings(repoRoot, updatedBindings);

      const cache = readSotCache(repoRoot);
      const updatedCache = setSotCacheEntry(cache, id, {
        dec_id: id,
        sot_path: "ledger",
        body_hash: bodyContentHash(block.prose),
        tokens: Array.from(tokenize(block.prose, { codeAware: true })),
        shingles: [],
        mtime_ms: Date.now(),
      });
      updatedCache.generated = new Date().toISOString();
      writeSotCache(repoRoot, updatedCache);

      // Topic-index entry so phase 7 sees this slug as already emitted.
      const slug = topicSlug(block.prose);
      const ti = readTopicIndex(repoRoot);
      const updatedTi = setTopic(ti, slug, {
        slug,
        dec_id: id,
        sot_source: block.file,
        candidates: [
          {
            file: block.file,
            kind: "source-comment",
            line_range: [block.startLine, block.endLine],
          },
        ],
        created_at: now,
      });
      updatedTi.generated = now;
      writeTopicIndex(repoRoot, updatedTi);

      const am = readAnchorMap(repoRoot);
      const baseAm = Object.keys(am.anchors).length > 0 ? am : emptyAnchorMap();
      const updatedAm = setAnchor(baseAm, slug, {
        file: block.file,
        content_hash: bodyContentHash(block.prose),
        line_range: [block.startLine, block.endLine],
        kind: "source-comment",
      });
      updatedAm.generated = now;
      writeAnchorMap(repoRoot, updatedAm);

      // Ghost: no `§` cite will ever bind this file → id, so record it now.
      bindGhostScope(repoRoot, block.file, id, isDec);

      try {
        if (isDec) writeDecisionsLedger({ repoRoot });
        else writeInvariantsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "ledger rebuild failed after Layer A emit",
        );
      }
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Layer A ledger emit failed",
    );
    return null;
  }
  return { id, kind: isDec ? "DEC" : "INV" };
}

function firstLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^[#*\-\s>]+/, "").trim().slice(0, 120) || "(untitled)";
}

/* -------------------------------------------------------------------------- */
/* Body lookup                                                                */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Verdict cache                                                              */
/* -------------------------------------------------------------------------- */

type VerdictScope =
  | "dedup-p1"
  | "dedup-p2"
  | "create-p1"
  | "create-p2"
  | "delta-extract"
  | "delta-classify";

function readVerdictCache(
  repoRoot: string,
  scope: VerdictScope,
  blockBody: string,
  scopeKey: string,
): string | null {
  const path = verdictCachePath(repoRoot, scope, blockBody, scopeKey);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsedRaw = JSON.parse(raw);
    const result = VerdictCacheSchema.safeParse(parsedRaw);
    return result.success ? result.data.verdict : null;
  } catch {
    return null;
  }
}

function writeVerdictCache(
  repoRoot: string,
  scope: VerdictScope,
  blockBody: string,
  scopeKey: string,
  verdict: string,
): void {
  const path = verdictCachePath(repoRoot, scope, blockBody, scopeKey);
  try {
    writeFileSafe(path, JSON.stringify({ verdict, ts: new Date().toISOString() }, null, 2));
  } catch {
    /* best-effort */
  }
}

function verdictCachePath(
  repoRoot: string,
  scope: VerdictScope,
  blockBody: string,
  scopeKey: string,
): string {
  const blockHash = createHash("sha256").update(blockBody, "utf8").digest("hex").slice(0, 12);
  return cairnDir(repoRoot, "cache", "haiku", scope, `${blockHash}-${scopeKey}.json`);
}

/* -------------------------------------------------------------------------- */
/* Staleness defer + statusline                                               */
/* -------------------------------------------------------------------------- */

function deferToStaleness(
  repoRoot: string,
  block: CommentBlock,
  reason: string,
): void {
  try {
    recordDriftEvent(repoRoot, {
      ts: new Date().toISOString(),
      kind: "doc-drift",
      path: block.file,
      detail: `Layer A deferred block at ${block.file}:${block.startLine}-${block.endLine}; reason=${reason}`,
      severity: "soft",
    });
    // Append the verbatim block + reason to a Layer-A-specific JSONL so
    // Layer C can pick it up without re-walking the file.
    const path = cairnDir(repoRoot, "staleness", "layer-a-deferred.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        file: block.file,
        startLine: block.startLine,
        endLine: block.endLine,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        prose: block.prose,
        reason,
      })}\n`,
      "utf8",
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "staleness defer write failed",
    );
  }
}

function pushAlignBlip(
  repoRoot: string,
  sessionId: string | null,
  decId: string,
  kind: "aligned" | "created-dec" | "created-inv" | "supplemented" | "constrained",
): void {
  if (sessionId === null) return;
  try {
    pushEvent(repoRoot, sessionId, { kind, primary_id: decId });
  } catch {
    /* best-effort */
  }
}

/* -------------------------------------------------------------------------- */
/* Tier-1 picker — full body / shingle / length checks                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Hook runner — `cairn hook sot-align`                                       */
/* -------------------------------------------------------------------------- */

interface PostToolUseShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

function emitShapeB(additionalContext: string): void {
  const out: PostToolUseShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = ClaudePostToolUsePayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function computeRelPath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  if (rel.startsWith("..") || rel.length === 0) return filePath;
  return rel.replace(/\\/g, "/");
}

function summarize(result: AlignFileResult): string {
  const parts: string[] = [];
  if (result.tier1Aligned > 0) parts.push(`tier1=${result.tier1Aligned}`);
  if (result.tier2Aligned > 0) parts.push(`tier2=${result.tier2Aligned}`);
  if (result.decsCreated > 0) parts.push(`decs=${result.decsCreated}`);
  if (result.invsCreated > 0) parts.push(`invs=${result.invsCreated}`);
  if (result.deferredToStaleness > 0) parts.push(`deferred=${result.deferredToStaleness}`);
  if (parts.length === 0) return "";
  return `cairn:sot-align — ${parts.join(" · ")}`;
}

export async function runSotAlign(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    const tool = payload.tool_name;
    if (tool !== "Write" && tool !== "Edit") {
      emitShapeB("");
      return;
    }
    const filePath = payload.tool_input?.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      emitShapeB("");
      return;
    }
    const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const result = await executeSotAlign(payload, repoRoot);
    emitShapeB(result);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Layer A hook failed; degrading to no-op",
    );
    emitShapeB("");
  }
}

export async function executeSotAlign(
  payload: ClaudePostToolUsePayload,
  repoRoot: string,
): Promise<string> {
  const filePath = payload.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return "";

  const relPath = computeRelPath(repoRoot, filePath);
  // Skip cairn's own state surface
  if (relPath === ".cairn" || relPath.startsWith(".cairn/")) return "";
  // Skip files outside the repo root.
  if (relPath.startsWith("../")) return "";

  // Diff-aware short-circuit: skip the alignFile pass entirely when
  // the edit's diff text contains no essay-class comment shape. Most
  // Edits are mechanical (var rename, type tweak, single-line bugfix)
  // and don't touch prose blocks; running alignFile against the whole
  // file's existing comment blocks for those edits burns 1-30s of
  // Haiku latency for zero signal. The shape detector matches JSDoc
  // blocks, JSDoc continuation lines (the `*` prefix), 3+
  // consecutive `//` lines, and Python `"""` docstrings. Any of those
  // appearing in old_string OR new_string (Edit) or content (Write)
  // means the edit COULD affect prose; alignFile runs as before.
  // False-negatives (a single non-`*`-prefixed line tweak inside a
  // pre-existing `// 3+` block) get caught at commit boundary by
  // Layer B's pre-commit pass + `cairn fix align`.
  const tool = payload.tool_name;
  if (tool === "Edit") {
    const newStr = payload.tool_input?.new_string ?? "";
    const oldStr = payload.tool_input?.old_string ?? "";
    if (
      !containsEssayClassShape(newStr) &&
      !containsEssayClassShape(oldStr)
    ) {
      return "";
    }
  } else if (tool === "Write") {
    const content = payload.tool_input?.content ?? "";
    if (!containsEssayClassShape(content)) {
      return "";
    }
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : null;

  const result = await alignFile({ repoRoot, filePath: relPath, sessionId });
  return summarize(result);
}

/* -------------------------------------------------------------------------- */
/* Augments sibling emit (Pass 2 augments path)                               */
/* -------------------------------------------------------------------------- */

interface AugmentEmit {
  id: string;
  kind: "DEC" | "INV";
}

async function emitAugmentSibling(args: {
  repoRoot: string;
  block: CommentBlock;
  delta: string;
  deltaKind: DeltaKind;
  existingId: string;
}): Promise<AugmentEmit | null> {
  const { repoRoot, block, delta, deltaKind, existingId } = args;
  const isInv = deltaKind === "constraint";
  // Augments sibling id is keyed on (existingId, source location) so the
  // same delta firing twice (re-run) hits the same id.
  const inputs = {
    source_file: block.file,
    source_offset: block.startLine,
    capture_source: `${CAPTURE_SOURCE}-augments-${existingId}`,
  };
  const id = isInv ? deriveLedgerInvId(inputs) : deriveLedgerDecId(inputs);
  const now = new Date().toISOString();
  const trimmedDelta = delta.trim();
  const title = firstLine(trimmedDelta);
  const fm: Record<string, unknown> = {
    id,
    title,
    type: isInv ? "invariant" : "adr",
    status: isInv ? "active" : "accepted",
    audience: "dual",
    generated: now,
    "verified-at": now,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(trimmedDelta),
    capture_source: CAPTURE_SOURCE,
    source_file: block.file,
  };
  if (isInv) {
    // INV augments derives_from the existing target — frontmatter plan §3.2.
    fm["derived_from"] = existingId;
  } else {
    // DEC augments relates to the existing target.
    fm["related"] = existingId;
  }
  if (!isInv) {
    fm["decided_at"] = now;
    fm["decided_by"] = "cairn-layer-a-augments";
  }
  const dir = isInv ? invariantsDir(repoRoot) : decisionsDir(repoRoot);
  const abs = join(dir, `${id}.md`);
  if (existsSync(abs)) {
    return { id, kind: isInv ? "INV" : "DEC" };
  }
  try {
    await withWriteLock(repoRoot, () => {
      mkdirSync(dir, { recursive: true });
      const out = `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${trimmedDelta}\n`;
      writeFileSync(abs, out, "utf8");

      // Bind new id → ledger.
      const bindings = readSotBindings(repoRoot);
      const updatedBindings = bindDec(bindings, id, "ledger");
      updatedBindings.generated = new Date().toISOString();
      writeSotBindings(repoRoot, updatedBindings);

      // Append delta tokens to sot-cache so the augments DEC/INV is
      // visible to subsequent Tier 1/2 passes within the same run.
      const cache = readSotCache(repoRoot);
      const updatedCache = setSotCacheEntry(cache, id, {
        dec_id: id,
        sot_path: "ledger",
        body_hash: bodyContentHash(trimmedDelta),
        tokens: Array.from(tokenize(trimmedDelta, { codeAware: true })),
        shingles: [],
        mtime_ms: Date.now(),
      });
      updatedCache.generated = new Date().toISOString();
      writeSotCache(repoRoot, updatedCache);

      // Topic-index entry — distinct slug from existing target's body.
      const slug = topicSlug(trimmedDelta);
      const ti = readTopicIndex(repoRoot);
      const updatedTi = setTopic(ti, slug, {
        slug,
        dec_id: id,
        sot_source: block.file,
        candidates: [
          {
            file: block.file,
            kind: "source-comment",
            line_range: [block.startLine, block.endLine],
          },
        ],
        created_at: now,
      });
      updatedTi.generated = now;
      writeTopicIndex(repoRoot, updatedTi);

      const am = readAnchorMap(repoRoot);
      const baseAm = Object.keys(am.anchors).length > 0 ? am : emptyAnchorMap();
      const updatedAm = setAnchor(baseAm, slug, {
        file: block.file,
        content_hash: bodyContentHash(trimmedDelta),
        line_range: [block.startLine, block.endLine],
        kind: "source-comment",
      });
      updatedAm.generated = now;
      writeAnchorMap(repoRoot, updatedAm);

      // Ghost: bind file → id at emit (augment path) — no cite will record it.
      bindGhostScope(repoRoot, block.file, id, !isInv);

      try {
        if (isInv) writeInvariantsLedger({ repoRoot });
        else writeDecisionsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "ledger rebuild failed after augments emit",
        );
      }
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "augments sibling emit failed",
    );
    return null;
  }
  return { id, kind: isInv ? "INV" : "DEC" };
}

/**
 * Augments cite preserves the existing § token and adds the sibling
 * cite alongside it. Replacement collapses the original block to two
 * stacked cite lines so both DEC bodies render at this site.
 */
function buildAugmentCiteItem(
  block: CommentBlock,
  existingId: string,
  newId: string,
): ReplaceItem {
  const a = formatBareCitation(block.lang, existingId);
  const b = formatBareCitation(block.lang, newId);
  return {
    blockId: block.id,
    file: block.file,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
    replacement: `${a}\n${b}`,
    expectedRaw: block.raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Alignment-pending queue — shared with Layer C drain via ground module      */
/* -------------------------------------------------------------------------- */
// `writeAlignmentPending` lives in ground/alignment-pending.ts so both
// the Layer A hook (here) and the Layer C SessionStart drain can write
// to the same attention surface with the same on-disk shape.
