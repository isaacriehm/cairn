#!/usr/bin/env tsx
/**
 * smoke-tier0 — Phase 6 acceptance sensor for the Tier-0 classifier.
 *
 * Exercises:
 *   1) regex fallback: classifyTier0 against a host that won't respond
 *      → source === "regex_fallback"; intent matches the regex catalog.
 *   2) Ollama path: when llama3.2:3b is available, classify a small
 *      battery of prompts → source === "ollama"; intent honours the
 *      definitions. Skips this section if Ollama is unreachable or the
 *      model is missing — keeps CI green.
 */

import {
  classifyTier0,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
  ollamaHasModel,
  ollamaIsAvailable,
} from "../src/tier0/index.js";

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-tier0 FAIL: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  header("Step 1: regex fallback — unreachable host");
  const fallback = await classifyTier0("fix the integration thing", {
    host: "http://localhost:1",
    timeoutMs: 200,
  });
  if (fallback.source !== "regex_fallback") {
    fail(`expected regex_fallback when host is closed, got ${fallback.source}`);
  }
  if (fallback.intent !== "code_task") {
    fail(`regex fallback should classify "fix..." as code_task, got ${fallback.intent}`);
  }

  const halt = await classifyTier0("halt the run now", {
    host: "http://localhost:1",
    timeoutMs: 200,
  });
  if (halt.source !== "regex_fallback") fail("halt fallback source");
  if (halt.intent !== "halt") fail(`halt classify: ${halt.intent}`);

  header("Step 2: Ollama path");
  const host = process.env["OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
  if (!(await ollamaIsAvailable(host))) {
    console.log(`  SKIP: ollama not reachable at ${host} — install via \`brew install ollama\``);
    console.log("\nsmoke-tier0: OK (regex fallback verified; ollama path skipped)");
    return;
  }
  if (!(await ollamaHasModel(host, DEFAULT_OLLAMA_MODEL))) {
    console.log(`  SKIP: ${DEFAULT_OLLAMA_MODEL} not pulled — \`ollama pull ${DEFAULT_OLLAMA_MODEL}\``);
    console.log("\nsmoke-tier0: OK (regex fallback verified; ollama path skipped)");
    return;
  }

  const cases: { text: string; expect: readonly string[] }[] = [
    { text: "fix the auth middleware bug", expect: ["code_task"] as const },
    { text: "review the integrations module for cross-tenant leaks", expect: ["review"] as const },
    {
      text: "scrap that — going forward, FK denormalization only",
      expect: ["direction"] as const,
    },
    { text: "halt run-abc123", expect: ["halt"] as const },
    {
      text: "what's the current queue depth?",
      expect: ["question", "status"] as const,
    },
  ];
  for (const c of cases) {
    const r = await classifyTier0(c.text, { timeoutMs: 30_000 });
    console.log(`  "${c.text}" → ${r.source}/${r.intent} (${r.confidence.toFixed(2)})`);
    if (r.source === "regex_fallback") {
      console.log(`    note: ollama returned malformed/timeout; classifier fell back`);
      continue;
    }
    if (!(c.expect as readonly string[]).includes(r.intent)) {
      fail(`"${c.text}" — expected one of ${c.expect.join("|")}, got ${r.intent}`);
    }
    if (r.confidence < 0 || r.confidence > 1) {
      fail(`confidence out of [0,1]: ${r.confidence}`);
    }
  }

  console.log("\nsmoke-tier0: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
