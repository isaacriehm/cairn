/**
 * Phase 5b — Haiku semantic judge wrapper.
 *
 * Used by the topic-index resolver to decide whether two prose blocks
 * with high Jaccard similarity but distinct content fingerprints are
 * actually about the same decision/topic. Verbatim collisions never
 * reach this — they're settled deterministically by slug equality.
 *
 * The prompt is intentionally minimal so the judge can answer in a
 * single token (`same` / `different`). Fall back to "different" on any
 * timeout / parse failure so the resolver doesn't aggressively merge
 * topics it isn't sure about — false-positive merges hide real DECs.
 */

import { runClaude } from "../../claude/index.js";
import { logger } from "../../logger.js";
import type { SemanticJudge, SemanticVerdict } from "./resolve.js";

const log = logger("init.topic-index.judge");

const SYSTEM = "You decide whether two prose blocks describe the SAME decision/topic. Reply with exactly one word: same or different.";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["same", "different"] },
  },
} as const;

const TIMEOUT_MS = 8_000;

export interface JudgeOptions {
  repoRoot?: string;
  /** Disable Haiku and always return "different" (used by smoke runs). */
  offline?: boolean;
}

export function makeHaikuJudge(opts: JudgeOptions = {}): SemanticJudge {
  return async ({ a, b }) => {
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
      if (typeof parsed !== "object" || parsed === null) return "different";
      const verdictRaw = (parsed as Record<string, unknown>)["verdict"];
      const verdict: SemanticVerdict = verdictRaw === "same" ? "same" : "different";
      return verdict;
    } catch (err) {
      log.warn({ err, a: a.file, b: b.file }, "haiku judge failed; falling back to 'different'");
      return "different";
    }
  };
}
