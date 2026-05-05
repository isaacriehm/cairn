#!/usr/bin/env tsx
/**
 * smoke-dec-tokens — exercises resolveDecision against in-memory fixtures.
 *
 * Covers:
 *   1. Missing decisions dir / ledger -> unknown (no throw)
 *   2. Decision found via frontmatter scan -> accepted + title
 *   3. Unknown DEC id -> status "unknown", title falls back to id
 *   4. §DEC-NNNN regex matches (bare token AND hash-comment prefix forms)
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LensResolver } from "../dist/resolver.js";

const cleanups: string[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lens-dec-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-dec-tokens — start");

  // 1. Missing decisions dir -> unknown, no throw
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
    const resolver = new LensResolver(repoRoot);
    const r = resolver.resolveDecision("DEC-0001");
    assert(r.status === "unknown", `Step 1: expected unknown, got ${r.status}`);
    assert(r.id === "DEC-0001", "Step 1: id round-trip");
    assert(r.title === "DEC-0001", "Step 1: title fallback to id");
    console.log("  PASS  Step 1 — missing decisions dir -> unknown (no throw)");
  }

  // 2. DEC found via frontmatter scan -> accepted
  {
    const repoRoot = mkFixture();
    const decDir = join(repoRoot, ".cairn", "ground", "decisions");
    mkdirSync(decDir, { recursive: true });
    writeFileSync(
      join(decDir, "DEC-0001.md"),
      `---
id: DEC-0001
title: Use strict null checks everywhere
status: accepted
---

Body text here.
`,
      "utf8",
    );
    writeFileSync(
      join(decDir, "DEC-0002.md"),
      `---
id: DEC-0002
title: Prefer immutable data structures
status: accepted
---
`,
      "utf8",
    );
    const resolver = new LensResolver(repoRoot);
    const r1 = resolver.resolveDecision("DEC-0001");
    assert(
      r1.status === "accepted" && r1.title === "Use strict null checks everywhere",
      `Step 2: DEC-0001 wrong: ${JSON.stringify(r1)}`,
    );
    const r2 = resolver.resolveDecision("DEC-0002");
    assert(
      r2.status === "accepted" && r2.title === "Prefer immutable data structures",
      `Step 2: DEC-0002 wrong: ${JSON.stringify(r2)}`,
    );
    console.log("  PASS  Step 2 — frontmatter scan -> accepted + title");
  }

  // 3. Unknown DEC id (not in any .md) -> unknown, title = id
  {
    const repoRoot = mkFixture();
    const decDir = join(repoRoot, ".cairn", "ground", "decisions");
    mkdirSync(decDir, { recursive: true });
    writeFileSync(
      join(decDir, "DEC-0001.md"),
      `---\nid: DEC-0001\ntitle: Only one DEC\nstatus: accepted\n---\n`,
      "utf8",
    );
    const resolver = new LensResolver(repoRoot);
    const r = resolver.resolveDecision("DEC-9999");
    assert(r.status === "unknown", `Step 3: expected unknown, got ${r.status}`);
    assert(r.id === "DEC-9999", "Step 3: id round-trip");
    console.log("  PASS  Step 3 — unknown DEC id -> unknown");
  }

  // 4. §DEC-NNNN regex correctness (bare and hash-comment forms)
  {
    const DECISION_TOKEN_RE = /§(DEC-\d+)/g;
    const cases: [string, string[]][] = [
      // bare token in source
      ["const x = 1; // §DEC-0001", ["DEC-0001"]],
      // hash-comment form (Python/Ruby/shell)
      ["# §DEC-0007", ["DEC-0007"]],
      // multiple on one line
      ["§DEC-0001 and §DEC-0042", ["DEC-0001", "DEC-0042"]],
      // no token
      ["no citation here", []],
      // old format should NOT match (we no longer emit "// See DEC-NNNN: title")
      ["// See DEC-0001: some title", []],
    ];
    for (const [line, expected] of cases) {
      const found = [...line.matchAll(DECISION_TOKEN_RE)].map((m) => m[1] as string);
      assert(
        JSON.stringify(found) === JSON.stringify(expected),
        `Step 4: line "${line}" -> expected ${JSON.stringify(expected)}, got ${JSON.stringify(found)}`,
      );
    }
    console.log("  PASS  Step 4 — §DEC-NNNN regex (bare + hash-comment)");
  }

  console.log("smoke-dec-tokens — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
