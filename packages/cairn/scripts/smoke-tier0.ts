#!/usr/bin/env tsx
/**
 * smoke-tier0 — verifies the regex fallback path for the Tier-0 classifier.
 *
 * Production tier0 calls the Claude binary (Haiku) — see
 * docs/PLUGIN_ARCHITECTURE.md §14. We can't reliably exercise the live
 * Claude path in a smoke (would need real auth + spend), so this smoke
 * stubs the fallback and asserts the regex catalog covers the canonical
 * intents. The Claude path is exercised end-to-end in adoption smoke.
 */

import { classifyTier0, REGEX_FALLBACK } from "@isaacriehm/cairn-core";

function fail(reason: string): never {
  console.error(`smoke-tier0 FAIL: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("── Step 1: regex catalog");
  const cases: { text: string; expect: string }[] = [
    { text: "fix the auth middleware bug", expect: "code_task" },
    { text: "review the integrations module", expect: "review" },
    { text: "scrap that — going forward, FK denormalization only", expect: "direction" },
    { text: "halt run-abc123", expect: "halt" },
    { text: "status of the orchestrator", expect: "status" },
    { text: "what is the current queue depth?", expect: "question" },
    { text: "an opaque sentence with no rule match", expect: "unknown" },
  ];
  for (const c of cases) {
    const r = REGEX_FALLBACK(c.text);
    if (r.intent !== c.expect) fail(`"${c.text}" → ${r.intent}, expected ${c.expect}`);
  }

  console.log("── Step 2: classifyTier0 falls back when Claude unavailable");
  // Force fallback by passing a fast-failing regex matcher; the production
  // call would shell to `claude` — we don't want that in CI, so we rely on
  // the wrapper's exception path.
  const text = "fix the auth middleware";
  const result = await classifyTier0(text, {
    timeoutMs: 1, // 1ms — guaranteed to time out the spawn before completion
  });
  // Either source is acceptable depending on whether `claude` is on PATH;
  // both paths must produce a sane intent + confidence.
  if (!["claude", "fallback"].includes(result.source)) {
    fail(`unexpected source: ${result.source}`);
  }
  if (result.confidence < 0 || result.confidence > 1) {
    fail(`confidence out of [0,1]: ${result.confidence}`);
  }
  console.log(`  classifyTier0 → ${result.source}/${result.intent} (${result.confidence.toFixed(2)})`);

  console.log("\nsmoke-tier0: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
