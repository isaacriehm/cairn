/**
 * Phase 5b — Haiku semantic judge wrapper.
 *
 * Used by the topic-index resolver to decide whether two prose blocks
 * with high Jaccard similarity but distinct content fingerprints are
 * actually about the same decision/topic.
 */

import { logger } from "../../logger.js";
import { runClaude } from "../../claude/index.js";
import { ClaudeError } from "../../claude/error.js";
import type { ProseBlock, SemanticJudge, SemanticVerdict } from "./resolve.js";
import { z } from "zod";

const log = logger("init.topic-index.judge");

const VerdictSchema = z.object({
  verdict: z.enum(["same", "different"]),
}).passthrough();

export interface JudgeOptions {
  repoRoot?: string;
  offline?: boolean;
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

const TIMEOUT_MS = 20_000;

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
      const parsed = result.parsed;
      const resultParsed = VerdictSchema.safeParse(parsed);
      if (!resultParsed.success) return "different";
      return resultParsed.data.verdict;
    } catch (err) {
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
