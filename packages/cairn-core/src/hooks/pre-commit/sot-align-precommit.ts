/**
 * Layer B — git pre-commit hook (plan §4.2).
 *
 * Detection-only. Never modifies the commit. Never blocks. The hook
 * walks every staged file, runs the same Jaccard pre-filter + Tier 1
 * deterministic check used by Layer A, and writes one record per
 * prose block to `.cairn/staleness/pre-commit-deferred.jsonl` plus a
 * lightweight `pre-commit-drift` event to `.cairn/staleness/log.jsonl`.
 * Layer C (SessionStart drain) consumes both files: it re-checks each
 * entry against the (possibly changed) source location and runs Haiku
 * for ambiguous candidates.
 *
 * Why log-only at pre-commit: the operator may be committing via vim,
 * emacs, or IntelliJ without a live Cairn / Lens session, so there is
 * no UI to disambiguate edits in real time. Auto-modifying staged
 * content here would silently invert the operator's expectation of
 * "I committed exactly what I wrote." Layer C reconciles in the next
 * Claude Code session where Haiku is available and the statusline
 * surfaces results.
 *
 * Staged content is captured by mirroring `git show :<file>` into a
 * temp tree before walking — `walkSourceComments` reads from disk,
 * and we want to detect drift against the staged blob even when the
 * working tree has unstaged tweaks (e.g. partial `git add -p`).
 *
 * Markdown paths (`.md`/`.mdx`) are skipped: their canonical form is
 * the doc itself, so a `// §DEC-<hash>` cite would corrupt the prose.
 * Markdown drift is handled by phase 7's topic-index re-walk and
 * `cairn fix align` (Layer D).
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileSafe } from "@isaacriehm/cairn-state";
import { resolveRepoRoot } from "../../session-start/index.js";
import {
  bodyContentHash,
  layerADeferredLogPath,
  preCommitDeferredLogPath,
  PreCommitDriftLogEntry,
  readSotCache,
  recordDriftEvent,
  type SotCacheEntry,
} from "@isaacriehm/cairn-state";
import { logger } from "../../logger.js";
import { tokenize } from "../../text/jaccard.js";
import {
  TIER2_JACCARD_FLOOR,
  TOP_K_CANDIDATES,
  extractBlocks,
  isMarkdownPath,
  tier1PickWithBody,
  topKCandidates,
} from "../sot-align-common.js";

const log = logger("hooks.pre-commit.sot-align");

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface PreCommitAlignArgs {
  repoRoot: string;
  /**
   * Override the staged-file discovery. Defaults to `git diff --cached
   * --name-only --diff-filter=AM` against the repo root.
   */
  stagedFiles?: string[];
  /**
   * Override the staged-content reader. Defaults to `git show :<file>`.
   */
  readStagedContent?: (repoRoot: string, file: string) => string | null;
}

export interface PreCommitAlignResult {
  /** Staged files inspected. */
  filesScanned: number;
  /** Total prose blocks discovered across all staged files. */
  blocksConsidered: number;
  /** Tier 1 deterministic matches (high-confidence dedup candidates). */
  tier1Matches: number;
  /** Tier 2/3 ambiguous matches (Haiku judge needed at Layer C). */
  tier23Matches: number;
  /** Blocks skipped (length floor / token floor / markdown / no candidates). */
  skipped: number;
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

export function alignStagedTree(args: PreCommitAlignArgs): PreCommitAlignResult {
  const { repoRoot } = args;
  const result: PreCommitAlignResult = {
    filesScanned: 0,
    blocksConsidered: 0,
    tier1Matches: 0,
    tier23Matches: 0,
    skipped: 0,
  };

  const stagedFiles =
    args.stagedFiles ?? listStagedFiles(repoRoot);
  if (stagedFiles.length === 0) return result;

  const readStaged =
    args.readStagedContent ?? ((root, file) => readStagedFromGit(root, file));

  const cache = readSotCache(repoRoot);
  const cacheEntries = Object.values(cache.entries).filter(
    (e): e is SotCacheEntry => e.tokens.length > 0,
  );
  if (cacheEntries.length === 0) {
    // No DECs/INVs to compare against yet — fresh adoption.
    return result;
  }

  // Mirror staged blobs into a scratch tree so walkSourceComments can
  // read the staged version of each file (working tree may differ when
  // the operator used `git add -p`).
  const stageRoot = mkdtempSync(join(tmpdir(), "cairn-precommit-"));
  try {
    for (const rel of stagedFiles) {
      if (isMarkdownPath(rel)) {
        result.skipped += 1;
        continue;
      }
      const content = readStaged(repoRoot, rel);
      if (content === null) {
        result.skipped += 1;
        continue;
      }
      const dst = join(stageRoot, rel);
      writeFileSafe(dst, content);
      result.filesScanned += 1;

      const blocks = extractBlocks(stageRoot, rel);
      result.blocksConsidered += blocks.length;

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

        const candidates = topKCandidates(
          blockTokens,
          cacheEntries,
          TIER2_JACCARD_FLOOR,
          TOP_K_CANDIDATES,
        );
        if (candidates.length === 0) {
          result.skipped += 1;
          continue;
        }

        const tier1Match = tier1PickWithBody(repoRoot, block, candidates);
        if (tier1Match !== null) {
          appendDeferred(repoRoot, {
            ts: new Date().toISOString(),
            file: block.file,
            block_start_line: block.startLine,
            block_end_line: block.endLine,
            block_content_hash: bodyContentHash(block.prose).slice(0, 12),
            block_prose: block.prose,
            tier: "tier1",
            // Sort: tier1 winner first, remaining candidates after.
            candidates: [
              tier1Match,
              ...candidates.filter((c) => c.id !== tier1Match.id),
            ],
          });
          recordPreCommitDriftEvent(repoRoot, block.file, tier1Match.id);
          result.tier1Matches += 1;
          continue;
        }

        // No Tier 1 hit but candidates exist past the Jaccard floor —
        // log them so Layer C can run the Haiku dedup judge.
        appendDeferred(repoRoot, {
          ts: new Date().toISOString(),
          file: block.file,
          block_start_line: block.startLine,
          block_end_line: block.endLine,
          block_content_hash: bodyContentHash(block.prose).slice(0, 12),
          block_prose: block.prose,
          tier: "tier2-3",
          candidates,
        });
        recordPreCommitDriftEvent(repoRoot, block.file, candidates[0]?.id ?? null);
        result.tier23Matches += 1;
      }
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* CLI runner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Entry point for `cairn hook pre-commit-align`. Always exits 0 — the
 * git pre-commit hook must never block a commit on Layer B failures.
 */
export async function runPreCommitAlign(): Promise<void> {
  try {
    const repoRoot = resolveRepoRoot(process.cwd());
    if (repoRoot === null) {
      // Not inside a Cairn-adopted repo; defer silently.
      process.exit(0);
    }
    const result = alignStagedTree({ repoRoot });
    log.debug(
      {
        filesScanned: result.filesScanned,
        blocksConsidered: result.blocksConsidered,
        tier1Matches: result.tier1Matches,
        tier23Matches: result.tier23Matches,
        skipped: result.skipped,
      },
      "pre-commit-align",
    );
  } catch (err) {
    log.error({ err: String(err) }, "pre-commit-align failed; commit unaffected");
  }
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function listStagedFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=AM"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function readStagedFromGit(repoRoot: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function appendDeferred(repoRoot: string, entry: PreCommitDriftLogEntry): void {
  const path = preCommitDeferredLogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const validated = PreCommitDriftLogEntry.parse(entry);
  appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
  // Touch the layer-A deferred path's parent dir so the staleness
  // surface is uniformly created — keeps Layer C's drain readers
  // happy even on a fresh adoption with no Layer A activity yet.
  if (!existsSync(layerADeferredLogPath(repoRoot))) {
    mkdirSync(dirname(layerADeferredLogPath(repoRoot)), { recursive: true });
  }
}

function recordPreCommitDriftEvent(
  repoRoot: string,
  filePath: string,
  decId: string | null,
): void {
  recordDriftEvent(repoRoot, {
    ts: new Date().toISOString(),
    kind: "pre-commit-drift",
    path: filePath,
    detail:
      decId === null
        ? "Layer B logged a pre-commit-drift block; no candidate match"
        : `Layer B logged a pre-commit-drift block; top candidate ${decId}`,
    severity: "soft",
    dec_id: decId ?? undefined,
  });
}

