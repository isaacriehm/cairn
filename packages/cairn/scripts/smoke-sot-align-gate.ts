#!/usr/bin/env tsx
/**
 * smoke-sot-align-gate — Layer A creation pre-filter (CAIRN_ISSUES item 5).
 *
 * Locks the structural gate that stops the runtime sot-align hook from
 * minting junk invariants from non-rule prose. Before the gate, every
 * prose block reached the Haiku creation judge, which over-labeled
 * descriptions as `constraint` and produced a ~97%-junk invariant store
 * (banners, class descriptions, test-fixture notes, box-drawing rules).
 *
 *   Step 1 — predicate unit checks: isSeparatorBlock / hasConstraintShape
 *            / hasDecisionShape / isLedgerWorthyBlock.
 *   Step 2 — a file of pure junk blocks (separator banner, class
 *            description, fixture note, re-export) is gated to
 *            `descriptive` and the creation judge is NEVER invoked
 *            (mock counter stays 0). No entity created, source untouched.
 *   Step 3 — a `MUST NOT …` block clears the gate, reaches the judge,
 *            and a `constraint` verdict still mints an INV.
 *   Step 4 — a `chose X over Y because Z` block clears the gate via
 *            decision-shape and a `decision` verdict mints a DEC.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  alignFile,
  hasConstraintShape,
  hasDecisionShape,
  isLedgerWorthyBlock,
  isSeparatorBlock,
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
      /* best-effort */
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-gate-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commitAll(repoRoot: string): void {
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

async function main(): Promise<void> {
  console.log("smoke-sot-align-gate — start");

  // ── Step 1 — predicate unit checks ───────────────────────────────
  {
    assert(isSeparatorBlock("──────────────────────────"), "Step 1: box-drawing rule is a separator");
    assert(isSeparatorBlock("======== ==== ===="), "Step 1: ascii divider is a separator");
    assert(!isSeparatorBlock("We chose Redis over Memcached because latency."), "Step 1: real prose is not a separator");

    assert(hasConstraintShape("Callers MUST NOT flush before init."), "Step 1: MUST NOT is constraint-shaped");
    assert(hasConstraintShape("This handler is FORBIDDEN to mutate state."), "Step 1: FORBIDDEN is constraint-shaped");
    assert(hasConstraintShape("@cairn:rule tokens expire in 15m"), "Step 1: @cairn:rule marker is constraint-shaped");
    assert(!hasConstraintShape("The buffer is append-only for the audit log."), "Step 1: 'append-only' does NOT trip ONLY");
    assert(!hasConstraintShape("Maps the row to the API shape."), "Step 1: plain description is not constraint-shaped");

    assert(hasDecisionShape("We chose Postgres over MySQL because JSONB."), "Step 1: chose…over…because is decision-shaped");
    assert(hasDecisionShape("We selected HS512 instead of RS256 because rotation."), "Step 1: selected…instead-of…because is decision-shaped");
    assert(!hasDecisionShape("We use Postgres for the primary store."), "Step 1: 'use X' alone is not a decision");
    assert(!hasDecisionShape("The events bus runs over the wire."), "Step 1: connector without a decision verb is not a decision");

    assert(isLedgerWorthyBlock("Callers MUST NOT flush before init.", ""), "Step 1: constraint block is ledger-worthy");
    assert(isLedgerWorthyBlock("We chose Redis over Memcached because durability.", ""), "Step 1: decision block is ledger-worthy");
    assert(!isLedgerWorthyBlock("UserRepo — maps DB rows to the API shape.", ""), "Step 1: class description is not ledger-worthy");
    assert(!isLedgerWorthyBlock("────────────────", ""), "Step 1: separator is not ledger-worthy");
    // Marker on a JSDoc tag line lives in raw, not prose — raw must be honored.
    assert(isLedgerWorthyBlock("tokens expire in 15m", "@cairn:rule\ntokens expire in 15m"), "Step 1: @cairn marker in raw is honored");
    console.log("  ✓ Step 1 — predicate unit checks");
  }

  // ── Step 2 — junk file: gated to descriptive, judge NEVER called ──
  {
    const repoRoot = mkRepoRoot();
    // Each block needs ≥2 content lines to be extracted as essay-class prose.
    const source = [
      "/**",
      " * ──────────────────────────────────────────────",
      " * ──────────────────────────────────────────────",
      " */",
      "export function a() {}",
      "",
      "/**",
      " * UserRepository is the persistence adapter that maps database rows onto",
      " * the API user shape returned to the frontend layer.",
      " */",
      "export function b() {}",
      "",
      "/**",
      " * activity.fixture.ts inserts a representative activities row into the test",
      " * database before the integration suite runs.",
      " */",
      "export function c() {}",
      "",
      "/**",
      " * This barrel file re-exports the public surface of the auth module for",
      " * downstream consumers and their tooling.",
      " */",
      "export function d() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/junk.ts", source);
    commitAll(repoRoot);

    // The creation judge THROWS — if any junk block reached it, alignFile
    // rejects and the smoke fails. Proves the gate short-circuits before
    // any Haiku call.
    const result = await alignFile({
      repoRoot,
      filePath: "src/junk.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        throw new Error("creation judge must NOT be reached for junk blocks");
      },
    });
    assert(result.haikuCalls === 0, `Step 2: no Haiku calls, got ${result.haikuCalls}`);
    assert(result.invsCreated === 0, "Step 2: no INV minted from junk");
    assert(result.decsCreated === 0, "Step 2: no DEC minted from junk");
    assert(result.blocksConsidered >= 3, `Step 2: blocks extracted, got ${result.blocksConsidered}`);
    assert(result.descriptive >= 1, "Step 2: at least one block explicitly gated to descriptive");
    assert(
      result.descriptive + result.skipped === result.blocksConsidered,
      `Step 2: every junk block gated or skipped — none judged/created (descriptive=${result.descriptive}, skipped=${result.skipped}, considered=${result.blocksConsidered})`,
    );
    assert(
      result.tier1Aligned + result.tier2Aligned + result.pending === 0,
      "Step 2: no junk block cited or pended",
    );
    const after = readFileSync(join(repoRoot, "src/junk.ts"), "utf8");
    assert(after === source, "Step 2: source untouched — no cites injected");
    console.log(`  ✓ Step 2 — ${result.blocksConsidered} junk blocks gated, judge never reached, 0 entities`);
  }

  // ── Step 3 — MUST NOT clears the gate → judge → CANDIDATE (Q17) ──
  // A runtime `constraint` no longer auto-creates an active INV (the
  // low-confidence over-mint the prune cleaned up after; INV enforcement
  // is unwired). It routes to the alignment-pending candidate surface for
  // operator promotion — with NO second Haiku pass (no added latency).
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * Callers MUST NOT invoke flush() before the buffer has been initialized,",
      " * otherwise the partial frame corrupts the downstream decoder.",
      " */",
      "export function flush() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/flush.ts", source);
    commitAll(repoRoot);

    let creationCalls = 0;
    let p2Calls = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "src/flush.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "constraint";
      },
      mockCreationJudgePass2: async () => {
        p2Calls += 1;
        return "constraint";
      },
    });
    assert(creationCalls === 1, `Step 3: constraint block reaches judge, got ${creationCalls}`);
    assert(p2Calls === 0, "Step 3: no confirmation Pass-2 — constraint routes on Pass-1 alone (no added latency)");
    assert(result.invsCreated === 0, `Step 3: constraint NOT auto-minted as active INV, got ${result.invsCreated}`);
    assert(result.pending === 1, `Step 3: constraint routes to the alignment-pending candidate, got pending=${result.pending}`);
    assert(
      existsSync(join(repoRoot, ".cairn/ground/invariants")) === false ||
        readdirSync(join(repoRoot, ".cairn/ground/invariants")).filter((f) => f.endsWith(".md")).length === 0,
      "Step 3: active invariants ledger stays empty",
    );
    console.log("  ✓ Step 3 — MUST NOT clears gate → judge → candidate (not active ledger)");
  }

  // ── Step 4 — decision-shape clears the gate → judge → DEC ────────
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * We chose Redis over Memcached for the session cache because durability",
      " * across restarts matters for the login flow.",
      " */",
      "export function cache() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/cache.ts", source);
    commitAll(repoRoot);

    let creationCalls = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "src/cache.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "decision";
      },
    });
    assert(creationCalls === 1, `Step 4: decision block reaches judge, got ${creationCalls}`);
    assert(result.decsCreated === 1, `Step 4: DEC minted, got ${result.decsCreated}`);
    console.log("  ✓ Step 4 — decision-shape clears gate → judge → DEC");
  }

  // ── Step 5 — a rule-shaped comment in a TEST file is skipped whole ───
  // The exact `MUST NOT` block that minted an INV from src/flush.ts in
  // Step 3 produces nothing when it lives in a *.spec.ts: a spec's prose
  // ("the contact must roll back") reads like a rule but is test setup.
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * Callers MUST NOT invoke flush() before the buffer has been initialized,",
      " * otherwise the partial frame corrupts the downstream decoder.",
      " */",
      "export function flush() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/flush.spec.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/flush.spec.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        throw new Error("creation judge must NOT be reached for a test file");
      },
    });
    assert(result.blocksConsidered === 0, `Step 5: test file short-circuits before block extraction, got ${result.blocksConsidered}`);
    assert(result.invsCreated === 0 && result.decsCreated === 0, "Step 5: no entity minted from a test file");
    assert(result.haikuCalls === 0, "Step 5: no Haiku call for a test file");
    console.log("  ✓ Step 5 — rule-shaped comment in a *.spec.ts is skipped whole");
  }

  cleanup();
  console.log("\nsmoke-sot-align-gate — pass");
}

main().catch((err) => {
  console.error("smoke-sot-align-gate — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
