#!/usr/bin/env tsx
/**
 * smoke-cites-expand — `cairn cites expand` (CAIRN_ISSUES item 6).
 *
 * The inverse of sot-align's strip-replace: a `// §DEC-/§INV-` citation
 * line is expanded back to the entity body inline, as a plain comment.
 *
 *   Step 1 — pure transform: line/JSDoc/hash comment leaders preserved;
 *            multi-line bodies; dangling (no entity) left in place; a cite
 *            sharing a line with code left in place.
 *   Step 2 — file wrapper: resolves against the live ground store, writes
 *            in place, no §token remains; dry-run mutates nothing.
 *   Step 3 — repo walker: the working tree is scanned for §tokens (NOT the
 *            scope-index), so a cited file with no scope-index entry is
 *            still found and uncited.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bodyContentHash,
  expandCitesInFile,
  expandCitesInRepo,
  expandCitesInText,
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
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-cites-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "ground", "invariants"), { recursive: true });
  return dir;
}

function seedDec(repoRoot: string, id: string, body: string): void {
  const fm = [
    "---",
    `id: ${id}`,
    "title: Seeded",
    "type: adr",
    "status: accepted",
    "audience: dual",
    "sot_kind: ledger",
    "sot_path: ledger",
    `sot_content_hash: ${bodyContentHash(body)}`,
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  const kindDir = id.startsWith("INV-") ? "invariants" : "decisions";
  writeFileSync(join(repoRoot, ".cairn", "ground", kindDir, `${id}.md`), fm, "utf8");
}

function main(): void {
  console.log("smoke-cites-expand — start");

  // ── Step 1 — pure transform ──────────────────────────────────────
  {
    const bodies: Record<string, string> = {
      "DEC-abc1234": "Chose Postgres over MySQL.\nJSONB support was the deciding factor.",
      "INV-def5678": "Tokens MUST expire after 15 minutes.",
    };
    const resolve = (id: string): string | null => bodies[id] ?? null;

    // line comment, multi-line body, indentation preserved
    {
      const r = expandCitesInText("  // §DEC-abc1234", resolve);
      assert(r.expanded === 1, "Step 1: one cite expanded");
      assert(
        r.text === "  // Chose Postgres over MySQL.\n  // JSONB support was the deciding factor.",
        `Step 1: body inlined with leader+indent, got ${JSON.stringify(r.text)}`,
      );
    }
    // JSDoc continuation leader
    {
      const r = expandCitesInText(" * §INV-def5678", resolve);
      assert(r.text === " * Tokens MUST expire after 15 minutes.", `Step 1: JSDoc leader, got ${JSON.stringify(r.text)}`);
    }
    // hash leader (python/yaml/shell)
    {
      const r = expandCitesInText("# §INV-def5678", resolve);
      assert(r.text === "# Tokens MUST expire after 15 minutes.", `Step 1: hash leader, got ${JSON.stringify(r.text)}`);
    }
    // dangling cite — entity missing, left verbatim
    {
      const r = expandCitesInText("  // §DEC-0000000", resolve);
      assert(r.expanded === 0 && r.danglingSkipped === 1, "Step 1: dangling counted");
      assert(r.text === "  // §DEC-0000000", "Step 1: dangling cite left in place");
    }
    // cite sharing a line with code — left untouched
    {
      const r = expandCitesInText("const x = 1; // §DEC-abc1234", resolve);
      assert(r.expanded === 0 && r.inlineSkipped === 1, "Step 1: inline cite skipped");
      assert(r.text === "const x = 1; // §DEC-abc1234", "Step 1: inline cite line unchanged");
    }
    // no cites — passthrough
    {
      const r = expandCitesInText("export function f() {}\n", resolve);
      assert(r.expanded === 0 && r.text === "export function f() {}\n", "Step 1: passthrough unchanged");
    }
    console.log("  ✓ Step 1 — pure transform: leaders, multi-line, dangling, inline");
  }

  // ── Step 2 — file wrapper ────────────────────────────────────────
  {
    const repo = mkRepo();
    seedDec(repo, "DEC-1234567", "Chose BullMQ over Sidekiq for Node-native runtime.");
    const src =
      [
        "/**",
        " * §DEC-1234567",
        " */",
        "export function jobs() {}",
      ].join("\n") + "\n";
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "jobs.ts"), src, "utf8");

    // dry-run leaves the file untouched
    const dry = expandCitesInFile({ repoRoot: repo, filePath: "src/jobs.ts", dryRun: true });
    assert(dry.expanded === 1 && dry.changed === true, "Step 2: dry-run reports the expansion");
    assert(readFileSync(join(repo, "src", "jobs.ts"), "utf8") === src, "Step 2: dry-run wrote nothing");

    // real run rewrites the file
    const r = expandCitesInFile({ repoRoot: repo, filePath: "src/jobs.ts" });
    assert(r.expanded === 1 && r.changed === true, "Step 2: expansion applied");
    const after = readFileSync(join(repo, "src", "jobs.ts"), "utf8");
    assert(after.includes(" * Chose BullMQ over Sidekiq"), "Step 2: body inlined into JSDoc");
    assert(!after.includes("§DEC-"), "Step 2: no §DEC token remains");
    console.log("  ✓ Step 2 — file wrapper: dry-run safe, real run un-cites");
  }

  // ── Step 3 — repo walker via working-tree scan (no scope-index) ──
  {
    const repo = mkRepo();
    seedDec(repo, "DEC-7654321", "Use HS512 for token signing.");
    mkdirSync(join(repo, "src"), { recursive: true });
    // NOTE: deliberately write NO scope-index — the scan is the source of
    // truth, so a cited file with no index entry must still be found.
    writeFileSync(join(repo, "src", "auth.ts"), "// §DEC-7654321\nexport function sign() {}\n", "utf8");
    writeFileSync(join(repo, "src", "nocites.ts"), "export const k = 1;\n", "utf8");

    const r = expandCitesInRepo({ repoRoot: repo });
    assert(r.expanded === 1, `Step 3: one cite expanded repo-wide, got ${r.expanded}`);
    assert(r.filesChanged === 1, `Step 3: one file changed, got ${r.filesChanged}`);
    assert(r.files.length === 1 && r.files[0]?.filePath === "src/auth.ts", "Step 3: only the cited file reported");
    const after = readFileSync(join(repo, "src", "auth.ts"), "utf8");
    assert(after.startsWith("// Use HS512 for token signing."), "Step 3: auth.ts un-cited");
    assert(!after.includes("§DEC-"), "Step 3: no token remains");
    console.log("  ✓ Step 3 — repo walker: working-tree scan finds cited file, no scope-index needed");
  }

  cleanup();
  console.log("\nsmoke-cites-expand — pass");
}

try {
  main();
} catch (err) {
  console.error("smoke-cites-expand — fail");
  console.error(err);
  cleanup();
  process.exit(1);
}
