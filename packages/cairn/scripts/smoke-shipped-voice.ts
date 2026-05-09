#!/usr/bin/env tsx
/**
 * smoke-shipped-voice — shipped-skill voice-bleed scrub acceptance.
 *
 * Earlier versions of cairn-adopt / cairn-attention / cairn-direction /
 * reviewer.md hard-coded an operator-personal chat-reply voice into
 * the shipped skill bodies — every adopter on every project would have
 * inherited it. The fix strips the leak and routes voice through the
 * project-local `.cairn/ground/brand/voice.md` (already loaded by
 * spec-delta on SessionStart).
 *
 * Locks two contracts:
 *   1. NO file under packages/cairn-frontend-claudecode/ (skills,
 *      agents, commands, hooks, manifest, README) contains the literal
 *      `caveman` (case-insensitive). The single template-string match
 *      via comments stays out of shipped artifacts.
 *   2. Every shipped skill body (cairn-adopt, cairn-attention,
 *      cairn-direction, reviewer) cites
 *      `.cairn/ground/brand/voice.md` so the project-local override
 *      surface is documented in the skill body itself.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FRONTEND_DIR = join(REPO_ROOT, "packages", "cairn-frontend-claudecode");

const SHIPPED_BODIES = [
  "skills/cairn-adopt/SKILL.md",
  "skills/cairn-attention/SKILL.md",
  "skills/cairn-direction/SKILL.md",
  "agents/reviewer.md",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SCAN_EXTS = [".md", ".json"];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(abs);
    } else if (st.isFile() && SCAN_EXTS.some((ext) => entry.endsWith(ext))) {
      yield abs;
    }
  }
}

function scanCavemanLeaks(): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = [];
  const re = /caveman/i;
  for (const file of walk(FRONTEND_DIR)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i] ?? "")) {
        hits.push({ path: file, line: i + 1, text: (lines[i] ?? "").trim() });
      }
    }
  }
  return hits;
}

function main(): void {
  console.log("smoke-shipped-voice — start");

  header("Step 1 — no `caveman` references in shipped frontend artifacts");
  {
    const hits = scanCavemanLeaks();
    if (hits.length > 0) {
      console.error("  ✗ Found caveman references in shipped surfaces:");
      for (const hit of hits) {
        console.error(`     ${hit.path}:${hit.line} — ${hit.text}`);
      }
      fail(`caveman bleed detected (${hits.length} occurrence${hits.length === 1 ? "" : "s"})`);
    }
    pass("no caveman bleed in any shipped .md / .json");
  }

  header("Step 2 — every shipped skill body cites .cairn/ground/brand/voice.md");
  {
    const missing: string[] = [];
    for (const rel of SHIPPED_BODIES) {
      const abs = join(FRONTEND_DIR, rel);
      const raw = readFileSync(abs, "utf8");
      if (!raw.includes(".cairn/ground/brand/voice.md")) {
        missing.push(rel);
      }
    }
    if (missing.length > 0) {
      fail(`shipped bodies missing voice.md citation: ${missing.join(", ")}`);
    }
    pass(`all ${SHIPPED_BODIES.length} shipped bodies cite voice.md`);
  }

  header("Step 3 — voice.md cited as the chat-reply override surface");
  {
    const re = /chat[-\s]reply voice|chat reply voice/i;
    const failures: string[] = [];
    for (const rel of SHIPPED_BODIES) {
      const raw = readFileSync(join(FRONTEND_DIR, rel), "utf8");
      if (!re.test(raw)) failures.push(rel);
    }
    if (failures.length > 0) {
      fail(`shipped bodies missing chat-reply voice phrasing: ${failures.join(", ")}`);
    }
    pass(`voice.md is positioned as the chat-reply override in all bodies`);
  }

  console.log("\nsmoke-shipped-voice — pass");
}

main();
