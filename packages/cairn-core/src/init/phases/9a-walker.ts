/**
 * Phase 9a-walker — unified curator corpus walker (v0.9.0).
 *
 * Stub. Real implementation in a follow-up commit walks source
 * comments + doc paragraphs + rule sections, applies the regex
 * pre-filter from `curator/regex-prefilter.ts`, packs surviving
 * records into shards capped at 120k input tokens, and writes
 * `corpus.jsonl` + `shards.json` to `.cairn/init/curator/`.
 *
 * The cairn-adopt skill reads `shards.json` after this phase
 * completes and dispatches `cairn:curator-map` subagents in parallel
 * rounds of 4.
 */

import { cairnDir } from "@isaacriehm/cairn-state";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { PhaseResult, PhaseState, WalkerOutput } from "./types.js";

export async function runPhase9aWalker(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: WalkerOutput = { skipped: "self-adopt" };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9a-walker": skipped },
    };
    return {
      status: "complete",
      nextPhase: "9b-curate",
      state: advancePhase(next),
    };
  }
  // Real walker plugged in by `runCuratorWalker`.
  try {
    const { runCuratorWalker } = await import("../curator/walker.js");
    const walker = await runCuratorWalker({ repoRoot: state.repoRoot });
    const out: WalkerOutput = {
      corpus_path: walker.corpus_path,
      shards_path: walker.shards_path,
      // Absolute curator dir — the skill resolves curator paths under this so
      // ghost adoption writes final.jsonl out-of-repo where 9b-curate checks.
      curator_dir: cairnDir(state.repoRoot, "init", "curator"),
      records_total: walker.records_total,
      records_by_kind: walker.records_by_kind,
      dropped: walker.dropped,
      shards: walker.shards,
      total_input_tokens_estimate: walker.total_input_tokens_estimate,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9a-walker": out },
    };
    return {
      status: "complete",
      nextPhase: "9b-curate",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "9a-walker-failed",
        message: "Curator walker failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
