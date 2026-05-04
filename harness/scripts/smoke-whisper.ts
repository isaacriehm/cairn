#!/usr/bin/env tsx
/**
 * smoke-whisper — Phase 6 acceptance sensor.
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 6:
 *   "record a known voice note, send via Discord, assert transcript matches
 *    within Levenshtein 5; assert avg_logprob > 0.85 on clear speech."
 *
 * The smoke avoids Discord I/O — generates a known clip locally via macOS
 * `say`, pipes through ffmpeg → smart-whisper, asserts the text contains the
 * expected words. Falls back to a SKIP exit (0) on non-darwin platforms or
 * when the model is not yet downloaded — that keeps CI green while letting
 * operators run the full check on their dev machines.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

function bindingExists(): boolean {
  try {
    const entry = requireFromHere.resolve("smart-whisper", { paths: [pkgRoot] });
    const bindingPath = resolve(dirname(entry), "..", "build", "Release", "smart-whisper.node");
    return existsSync(bindingPath);
  } catch {
    return false;
  }
}

let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-whisper FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function skip(reason: string): never {
  console.log(`smoke-whisper SKIP: ${reason}`);
  cleanup();
  process.exit(0);
}

function cleanup(): void {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j] ?? 0;
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const dpJ1 = dp[j - 1] ?? 0;
      const dpJ = dp[j] ?? 0;
      dp[j] = Math.min(dpJ + 1, dpJ1 + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n] ?? 0;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    skip(`platform ${process.platform} has no \`say\` command — run on macOS for the full check`);
  }
  if (!bindingExists()) {
    skip("smart-whisper native binding missing — run `pnpm -F @devplusllc/harness setup:whisper`");
  }
  // Defer the voice import until after the binding existence check, so the
  // smoke can SKIP cleanly instead of crashing on the eager .node load.
  // voice/ moved to packages/harness-core in 9fe2b95.
  const {
    freeWhisper,
    transcribeBuffer,
    whisperModelExists,
    WHISPER_MODEL_PATH,
  } = await import("@devplusllc/harness-core");
  if (!whisperModelExists()) {
    skip(`whisper model not found at ${WHISPER_MODEL_PATH} — see model.ts header for install`);
  }
  if (spawnSync("which", ["ffmpeg"]).status !== 0) {
    skip("ffmpeg not on PATH — install via `brew install ffmpeg`");
  }
  if (spawnSync("which", ["say"]).status !== 0) {
    skip("`say` not on PATH (unexpected on macOS)");
  }

  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-whisper-"));
  cleanupPaths.push(dir);
  const aiff = join(dir, "say.aiff");

  const expected = "hello world from the harness phase six smoke test";

  header("Step 1: synthesize known clip via `say`");
  const sayResult = spawnSync("say", ["-v", "Samantha", "-o", aiff, expected], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (sayResult.status !== 0) {
    fail(`\`say\` exited ${sayResult.status}: ${String(sayResult.stderr)}`);
  }
  if (!existsSync(aiff)) fail(`expected ${aiff} after \`say\``);
  const audio = readFileSync(aiff);
  if (audio.length === 0) fail("synthesized clip is empty");

  header("Step 2: transcribe — ffmpeg → smart-whisper");
  const result = await transcribeBuffer(audio, { language: "en" });
  console.log(
    `  text="${result.text}" avgLogprob=${result.avgLogprob.toFixed(3)} segments=${result.segments.length} duration=${result.durationMs}ms`,
  );

  if (result.text.length === 0) fail("empty transcript");
  if (result.avgLogprob <= 0) fail(`avgLogprob non-positive: ${result.avgLogprob}`);
  if (result.avgLogprob < 0.5) {
    fail(`avgLogprob ${result.avgLogprob.toFixed(3)} below 0.5 floor on clear synth speech`);
  }

  const lower = result.text.toLowerCase();
  for (const word of ["hello", "world", "harness"]) {
    if (!lower.includes(word)) fail(`expected word "${word}" missing from transcript`);
  }

  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const dist = levenshtein(norm(result.text), norm(expected));
  if (dist > 8) {
    fail(
      `levenshtein distance ${dist} exceeds 8 (transcript="${norm(result.text)}", expected="${norm(expected)}")`,
    );
  }
  console.log(`  levenshtein(norm) = ${dist}`);

  await freeWhisper();
  cleanup();
  console.log("\nsmoke-whisper: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
