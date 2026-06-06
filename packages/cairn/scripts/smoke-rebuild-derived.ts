#!/usr/bin/env tsx
/**
 * smoke-rebuild-derived — `rebuildDerived` reconstructs gitignored derived
 * ground state from committed DEC/INV sources.
 *
 * Covers:
 *   - sot-bindings + sot-cache + ledgers rebuilt from a path-kind DEC
 *   - cold-start topic-index + anchor-map rebuild via content-hash rematch
 *   - warm re-run skips the prose walk (topicAnchorRebuilt === 0)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rebuildDerived,
  walkProseBlocks,
  readSotBindings,
  readSotCache,
  readAnchorMap,
  readTopicIndex,
  pathForDec,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-rebuild-"));
  cleanups.push(root);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });

  // A doc whose section becomes a path-kind DEC's source of truth.
  step("Step 1 — seed a doc + a path-kind DEC pinned to its content hash");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "auth.md"),
    "# Auth\n\n## Token lifetime\n\nAccess tokens expire after 24 hours. Refresh tokens last 30 days. " +
      "Always validate the audience claim before trusting a token in any downstream service for safety.\n",
    "utf8",
  );

  // Derive the real block hash/slug the walker produces, so the DEC's
  // sot_content_hash matches exactly (no need to replicate extraction).
  const blocks = walkProseBlocks(root);
  const sot = blocks.find((b) => b.file === "docs/auth.md");
  assert(sot !== undefined, "walker found a block in docs/auth.md");

  const decId = "DEC-a1b2c3d";
  mkdirSync(join(root, ".cairn", "ground", "decisions"), { recursive: true });
  writeFileSync(
    join(root, ".cairn", "ground", "decisions", `${decId}.md`),
    [
      "---",
      `id: ${decId}`,
      "title: Token lifetime is 24h",
      "status: accepted",
      "sot_kind: path",
      "sot_path: docs/auth.md",
      `sot_content_hash: ${sot!.content_hash}`,
      "---",
      "",
      "Access tokens expire after 24 hours. Refresh tokens last 30 days.",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`  block slug=${sot!.slug} hash=${sot!.content_hash.slice(0, 12)}…`);

  step("Step 2 — cold rebuildDerived reconstructs all derived state");
  const r1 = rebuildDerived(root);
  assert(r1.decisions === 1, "one accepted DEC counted");
  assert(r1.bindings === 1, "one sot-binding written");
  assert(r1.cacheEntries === 1, "one sot-cache entry written");
  assert(r1.topicAnchorRebuilt === 1, "one path entity relocated into topic/anchor");

  const bindings = readSotBindings(root);
  assert(pathForDec(bindings, decId) === "docs/auth.md", "binding resolves DEC → sot_path");

  const cache = readSotCache(root);
  assert(cache.entries[decId] !== undefined, "sot-cache has the DEC entry");

  const anchors = readAnchorMap(root);
  assert(anchors.anchors[sot!.slug] !== undefined, "anchor-map keyed by the block slug");
  assert(
    anchors.anchors[sot!.slug]!.file === "docs/auth.md",
    "anchor points at the source file",
  );

  const topic = readTopicIndex(root);
  assert(topic.topics[sot!.slug]?.dec_id === decId, "topic-index links slug → DEC id");
  console.log("  ✓ bindings + cache + ledger + anchor-map + topic-index rebuilt");

  step("Step 3 — warm re-run skips the prose walk");
  const r2 = rebuildDerived(root);
  assert(
    r2.topicAnchorRebuilt === 0,
    "topic/anchor present → walk skipped (warm)",
  );
  assert(r2.bindings === 1, "bindings still rebuilt on warm run");
  console.log("  ✓ warm run rebuilds the cheap set, skips the walk");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-rebuild-derived — pass");
}

main().catch((err) => {
  console.error("smoke-rebuild-derived — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
