/**
 * Phase 7 — Haiku semantic judge wrapper.
 *
 * Used by the topic-index resolver to decide whether two prose blocks
 * with high Jaccard similarity but distinct content fingerprints are
 * actually about the same decision/topic.
 */

import { logger } from "../../logger.js";
import { runClaude } from "../../claude/index.js";
import { ClaudeError } from "../../claude/error.js";
import type { SemanticJudge, SemanticVerdict } from "./resolve.js";
import { z } from "zod";

const log = logger("init.topic-index.judge");

const VerdictSchema = z.object({
  verdict: z.enum(["same", "different"]),
}).passthrough();

/**
 * Per-build counters for the Haiku judge. The orchestrator
 * (`buildTopicIndex`) constructs one and threads it through
 * `makeHaikuJudge`; the judge increments per call so the phase
 * output can split `judge_calls` into cached vs fresh vs errored.
 * Smokes that pass a mock judge skip this surface entirely — the
 * tally fields stay at 0, which is correct (no Haiku spend at all).
 */
export interface JudgeTally {
  cached: number;
  fresh: number;
  errors: number;
}

export interface JudgeOptions {
  repoRoot?: string;
  offline?: boolean;
  /** Optional counter object — when provided, every judge call updates one of cached / fresh / errors. */
  tally?: JudgeTally;
}

const SYSTEM =
  "You decide whether two prose blocks describe the SAME decision/topic. Reply with exactly one word: same or different.";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["same", "different"] },
  },
  required: ["verdict"],
  additionalProperties: false,
};

// 30s ceiling per judge call. Was 20s before — under sustained
// network or Haiku-side latency the 20s ceiling was hitting the
// timeout classification before the call had a chance to return,
// which then either tripped the breaker or accumulated as
// `unresolvedAmbiguous`. 30s is the longest a single judge call
// should ever take in practice; anything longer is genuinely stuck.
const TIMEOUT_MS = 30_000;

/**
 * Return a semantic judge implementation that calls Haiku.
 */
export function makeHaikuJudge(opts: JudgeOptions = {}): SemanticJudge {
  return async ({ a, b }): Promise<SemanticVerdict> => {
    if (opts.offline === true) return "different";
    const prompt = [
      "Block A:",
      `from ${a.file} (${a.kind})`,
      a.body,
      "",
      "Block B:",
      `from ${b.file} (${b.kind})`,
      b.body,
      "",
      "Are these two blocks about the SAME decision/topic? Reply with one word.",
    ].join("\n");
    try {
      const result = await runClaude({
        tier: "haiku",
        system: SYSTEM,
        prompt,
        jsonSchema: VERDICT_SCHEMA,
        timeoutMs: TIMEOUT_MS,
        isolateAmbientContext: true,
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot, cacheable: true } : {}),
      });
      if (opts.tally !== undefined) {
        if (result.cached) opts.tally.cached += 1;
        else opts.tally.fresh += 1;
      }
      const parsed = result.parsed;
      const resultParsed = VerdictSchema.safeParse(parsed);
      if (!resultParsed.success) return "different";
      return resultParsed.data.verdict;
    } catch (err) {
      if (opts.tally !== undefined) opts.tally.errors += 1;
      // Surface ClaudeError (timeout / rate_limit / overloaded / auth) to
      // the resolver so it can trip its circuit breaker and stop calling
      // the judge instead of burning wall-time on doomed retries.
      // Non-Claude errors (parse glitches, schema mismatch) are local to
      // a single pair — log + fall back to "different".
      if (err instanceof ClaudeError) throw err;
      log.warn({ err, a: a.file, b: b.file }, "haiku judge failed; falling back to 'different'");
      return "different";
    }
  };
}
