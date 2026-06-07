#!/usr/bin/env tsx
/**
 * smoke-init-phases-all — invoke each of the v0.9.0 phase functions
 * against a synthetic repo and assert the PhaseResult contract.
 *
 * Coverage:
 *   - Phases 1-detect, 2-walker: full execution on a fixture TS repo
 *     → status: complete, expected outputs stamped, nextPhase advances
 *   - Phase 5-preflight: auto-advances with ETA estimate stamped
 *   - Phase 6-brand: needs_input then complete on "skip"
 *   - Phase 8-docs-ingest: stamps `skipped: "merged-into-9-curator"`
 *     and advances to 9a-walker (v0.9.0 no-op)
 *   - Phase 9a-walker: end-to-end on a fixture repo with synthetic
 *     source comments + docs/ markdown → corpus.jsonl + shards.json
 *   - Phase 9b-curate: errors when final.jsonl is missing
 *   - Phase 9c-emit: emits a hand-rolled final.jsonl through the
 *     validators and verifies survivors land in `.cairn/ground/`
 *   - Phase 10-rules-merge: stamps `skipped: "merged-into-9-curator"`
 *     and advances to 11-baseline (v0.9.0 no-op)
 *   - Phase 12-strip: completes silently when no flagged modules
 *   - Phases 3-mapper, 11-baseline, 13-multidev: prereq error
 *     path / export surface verified
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURATOR_FINAL_PATH,
  freshPhaseState,
  runPhase12Strip,
  runPhase13Multidev,
  runPhase1Detect,
  runPhase2Walker,
  runPhase3Mapper,
  runPhase5Preflight,
  runPhase6Brand,
  runPhase8DocsIngest,
  runPhase9aWalker,
  runPhase9bCurate,
  runPhase9cEmit,
  runPhase9dCompWalk,
  runPhase10RulesMerge,
  runPhase11Baseline,
  type PhaseResult,
  type PhaseState,
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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-init-phases-all-"));
  cleanups.push(dir);
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email smoke@example.com', { cwd: dir });
  execSync('git config user.name "smoke"', { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "phase-smoke", version: "0.0.0", scripts: { dev: "tsx" } },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022" } }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n");
  return dir;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-init-phases-all — start");

  // ── Step 1 — phase 1-detect runs end-to-end ─────────────────────
  let after1: PhaseState;
  {
    const repo = mkRepo();
    const r = await runPhase1Detect(freshPhaseState(repo));
    assert(r.status === "complete", `Step 1: expected complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "2-walker", `Step 1: nextPhase should be 2-walker, got ${r.nextPhase}`);
    assert(
      r.state.outputs["1-detect"] !== undefined,
      "Step 1: outputs['1-detect'] should be populated",
    );
    after1 = r.state;
    console.log("  ✓ Step 1 — phase 1-detect → complete");
  }

  // ── Step 2 — phase 2-walker on the same state ───────────────────
  let after2: PhaseState;
  {
    const r = await runPhase2Walker(after1);
    assert(r.status === "complete", `Step 2: expected complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "3-mapper", `Step 2: nextPhase should be 3-mapper`);
    assert(
      r.state.outputs["2-walker"] !== undefined,
      "Step 2: outputs['2-walker'] should be populated",
    );
    after2 = r.state;
    console.log("  ✓ Step 2 — phase 2-walker → complete");
  }

  // ── Step 3 — phase 5-preflight auto-advances with ETA estimate ──
  {
    const stateForPreflight: PhaseState = {
      ...after2,
      currentPhase: "5-preflight",
    };
    const r = await runPhase5Preflight(stateForPreflight);
    assert(r.status === "complete", `Step 3: expected complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "6-brand", `Step 3: nextPhase should be 6-brand`);
    const out = r.state.outputs["5-preflight"];
    assert(out !== undefined, `Step 3: outputs['5-preflight'] should be populated`);
    assert(
      Array.isArray(out.bannerLines) && out.bannerLines.length > 0,
      `Step 3: bannerLines should be populated`,
    );
    assert(
      typeof out.eta.totalSeconds === "number",
      `Step 3: eta.totalSeconds should be a number`,
    );
    console.log("  ✓ Step 3 — phase 5-preflight → complete (ETA estimate emitted)");
  }

  // ── Step 4 — phase 6-brand needs_input → complete on "skip" ─────
  {
    const repo = mkRepo();
    const ask = await runPhase6Brand({ ...freshPhaseState(repo), currentPhase: "6-brand" });
    assert(ask.status === "needs_input", `Step 4: expected needs_input, got ${ask.status}`);
    if (ask.status !== "needs_input") return;
    assert(ask.question.id === "6-brand", `Step 4: question.id should be 6-brand`);
    assert(
      ask.question.options.some((o) => o.id === "skip"),
      `Step 4: skip option missing`,
    );
    const done = await runPhase6Brand({ ...ask.state, answer: "skip" });
    assert(done.status === "complete", `Step 4: expected complete on skip, got ${done.status}`);
    if (done.status !== "complete") return;
    assert(
      done.nextPhase === "7-topic-index",
      `Step 4: nextPhase should be 7-topic-index`,
    );
    console.log("  ✓ Step 4 — phase 6-brand → skip path");
  }

  // ── Step 5 — phase 12-strip silent-complete with empty queue ────
  {
    const repo = mkRepo();
    const r = await runPhase12Strip({ ...freshPhaseState(repo), currentPhase: "12-strip" });
    assert(r.status === "complete", `Step 5: expected complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "13-multidev", `Step 5: nextPhase should be 13-multidev`);
    console.log("  ✓ Step 5 — phase 12-strip → complete (no flagged modules)");
  }

  // ── Step 6 — prereq-missing error path for downstream phases ────
  {
    const repo = mkRepo();
    const fresh = freshPhaseState(repo);
    const phasesWithPrereqs = [
      { id: "3-mapper", run: runPhase3Mapper, code: "missing-prereqs" },
    ] as const;
    for (const p of phasesWithPrereqs) {
      const r = await p.run({ ...fresh, currentPhase: p.id as any });
      assert(
        r.status === "error",
        `Step 6: ${p.id} on empty state should error, got ${r.status}`,
      );
      if (r.status !== "error") return;
      assert(
        r.error.code === p.code,
        `Step 6: ${p.id} error.code should be ${p.code}, got ${r.error.code}`,
      );
    }
    console.log("  ✓ Step 6 — prereq-missing error path for 3-mapper");
  }

  // ── Step 7 — phase functions exposed for the long-running / curator phases ─
  {
    // Contract: each is a function returning a Promise. We don't run
    // most of them here (they hit LLMs / sensors that need real wiring);
    // the smoke just asserts the export surface so the MCP registration
    // has a stable target.
    const fns = [
      ["runPhase3Mapper", runPhase3Mapper],
      ["runPhase9aWalker", runPhase9aWalker],
      ["runPhase9bCurate", runPhase9bCurate],
      ["runPhase9cEmit", runPhase9cEmit],
      ["runPhase11Baseline", runPhase11Baseline],
      ["runPhase13Multidev", runPhase13Multidev],
    ] as const;
    for (const [name, fn] of fns) {
      assert(typeof fn === "function", `Step 7: ${name} must be exported as a function`);
    }
    console.log(`  ✓ Step 7 — long-running phase functions exported (${fns.length})`);
  }

  // ── Step 8 — phase 8 + 10 collapse to no-ops in v0.9.0 ───────────
  {
    const repo = mkRepo();
    const fresh = freshPhaseState(repo);
    const phase8Result = await runPhase8DocsIngest({
      ...fresh,
      currentPhase: "8-docs-ingest",
    });
    assert(
      phase8Result.status === "complete",
      `Step 8: phase 8 should complete as no-op, got ${phase8Result.status}`,
    );
    if (phase8Result.status !== "complete") return;
    assert(
      phase8Result.nextPhase === "9a-walker",
      `Step 8: phase 8 should advance to 9a-walker, got ${phase8Result.nextPhase}`,
    );
    const out8 = phase8Result.state.outputs["8-docs-ingest"];
    assert(
      out8?.skipped === "merged-into-9-curator",
      `Step 8: phase 8 should stamp 'merged-into-9-curator', got ${JSON.stringify(out8)}`,
    );
    const phase10Result = await runPhase10RulesMerge({
      ...fresh,
      currentPhase: "10-rules-merge",
    });
    assert(
      phase10Result.status === "complete",
      `Step 8: phase 10 should complete as no-op, got ${phase10Result.status}`,
    );
    if (phase10Result.status !== "complete") return;
    assert(
      phase10Result.nextPhase === "11-baseline",
      `Step 8: phase 10 should advance to 11-baseline, got ${phase10Result.nextPhase}`,
    );
    const out10 = phase10Result.state.outputs["10-rules-merge"];
    assert(
      out10?.skipped === "merged-into-9-curator",
      `Step 8: phase 10 should stamp 'merged-into-9-curator', got ${JSON.stringify(out10)}`,
    );
    console.log("  ✓ Step 8 — phase 8 + 10 no-op markers stamp + advance");
  }

  // ── Step 9 — phase 9a-walker end-to-end on a fixture repo ────────
  {
    const repo = mkRepo();
    // Seed an essay-class block comment that survives the prefilter.
    const srcDir = join(repo, "core", "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "session.ts"),
      [
        "/**",
        " * Session validation — must reject sessions older than 24h to keep",
        " * privilege escalation off the table after operator deactivation.",
        " * The cache TTL is the only enforcement point because every",
        " * downstream lookup goes through it.",
        " */",
        "export function validateSession(): void {}",
        "",
      ].join("\n"),
    );
    // Seed a doc paragraph above the 80-char minimum.
    const docsDir = join(repo, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, "auth.md"),
      [
        "# Auth",
        "",
        "Sessions are stored at the edge cache and expire after 24 hours of",
        "wall-clock time, regardless of activity. Operators can revoke a",
        "session by removing the cache entry directly.",
        "",
      ].join("\n"),
    );
    // Seed a CLAUDE.md H2 section (passes through rule sub-walker).
    writeFileSync(
      join(repo, "CLAUDE.md"),
      [
        "# Project rules",
        "",
        "## Authentication",
        "",
        "Auth tokens MUST expire after 24 hours. Renewals require a fresh",
        "challenge so we never extend a stolen token's lifetime.",
        "",
      ].join("\n"),
    );
    const fresh = freshPhaseState(repo);
    const r = await runPhase9aWalker({ ...fresh, currentPhase: "9a-walker" });
    assert(r.status === "complete", `Step 9: 9a-walker should complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "9b-curate", `Step 9: nextPhase should be 9b-curate`);
    const out = r.state.outputs["9a-walker"];
    assert(out !== undefined, "Step 9: outputs['9a-walker'] populated");
    assert(
      typeof out.records_total === "number" && out.records_total >= 1,
      `Step 9: walker should yield ≥1 surviving record, got ${out.records_total}`,
    );
    assert(
      typeof out.shards === "number" && out.shards >= 1,
      `Step 9: walker should pack ≥1 shard, got ${out.shards}`,
    );
    assert(
      existsSync(join(repo, ".cairn/init/curator/corpus.jsonl")),
      "Step 9: corpus.jsonl should be on disk",
    );
    assert(
      existsSync(join(repo, ".cairn/init/curator/shards.json")),
      "Step 9: shards.json should be on disk",
    );
    console.log("  ✓ Step 9 — 9a-walker end-to-end (corpus + shards on disk)");
  }

  // ── Step 10 — phase 9b-curate errors when final.jsonl missing ────
  {
    const repo = mkRepo();
    const fresh = freshPhaseState(repo);
    const r = await runPhase9bCurate({ ...fresh, currentPhase: "9b-curate" });
    assert(
      r.status === "error",
      `Step 10: 9b-curate without final.jsonl should error, got ${r.status}`,
    );
    if (r.status !== "error") return;
    assert(
      r.error.code === "9b-curate-missing-final",
      `Step 10: error code should be 9b-curate-missing-final, got ${r.error.code}`,
    );
    console.log("  ✓ Step 10 — 9b-curate errors when curator skill skipped");
  }

  // ── Step 11 — phase 9c-emit drops invalid + emits valid entries ──
  {
    const repo = mkRepo();
    // Need an evidence file the validator can resolve.
    const evRel = "core/src/auth/session.ts";
    mkdirSync(join(repo, "core/src/auth"), { recursive: true });
    writeFileSync(join(repo, evRel), "// seeded for 9c-emit smoke\n");
    // Hand-write final.jsonl: one valid DEC, one valid INV, one invalid
    // (missing scope_globs).
    const finalAbs = join(repo, CURATOR_FINAL_PATH);
    mkdirSync(join(repo, ".cairn/init/curator"), { recursive: true });
    const validDec = {
      kind: "DEC",
      title: "Reject sessions older than 24h at every cache lookup",
      body: [
        "## Context",
        "Sessions persist to the edge cache for 24h.",
        "",
        "## Decision",
        "Cache lookup verifies TTL; expired sessions are rejected immediately.",
        "",
        "## Why",
        "Stale sessions allow privilege escalation after operator deactivation.",
      ].join("\n"),
      scope_globs: ["core/src/auth/**"],
      evidence_files: [`${evRel}:1-10`],
      topic_tags: ["auth", "session"],
    };
    const validInv = {
      kind: "INV",
      title: "Cap login attempts to 5 per IP per minute",
      body: [
        "## Context",
        "Login endpoint is the brute-force surface for credential stuffing.",
        "",
        "## Invariant",
        "Per-IP rate limiter MUST cap login at 5 attempts per minute.",
        "",
        "## Why",
        "Wider caps cost almost nothing to attackers and lock out real users.",
      ].join("\n"),
      scope_globs: ["core/src/auth/**"],
      evidence_files: [evRel],
      topic_tags: ["auth", "rate-limit"],
    };
    const invalid = {
      kind: "DEC",
      title: "No scope globs entry",
      body: validDec.body,
      scope_globs: [],
      evidence_files: [evRel],
      topic_tags: ["auth"],
    };
    writeFileSync(
      finalAbs,
      [validDec, validInv, invalid].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const fresh = freshPhaseState(repo);
    const r = await runPhase9cEmit({ ...fresh, currentPhase: "9c-emit" });
    assert(r.status === "complete", `Step 11: 9c-emit should complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(r.nextPhase === "9d-comp-walk", `Step 11: nextPhase should be 9d-comp-walk`);
    const out = r.state.outputs["9c-emit"];
    assert(out !== undefined, "Step 11: outputs['9c-emit'] populated");
    assert(
      out.decsWritten?.length === 1,
      `Step 11: 1 DEC should land in ground, got ${out.decsWritten?.length}`,
    );
    assert(
      out.invsWritten?.length === 1,
      `Step 11: 1 INV should land in ground, got ${out.invsWritten?.length}`,
    );
    assert(
      out.dropped === 1,
      `Step 11: 1 entry should drop, got ${out.dropped}`,
    );
    const decId = out.decsWritten?.[0]?.id;
    const decPath = join(repo, ".cairn/ground/decisions", `${decId}.md`);
    assert(existsSync(decPath), `Step 11: DEC file should exist at ${decPath}`);
    const decBody = readFileSync(decPath, "utf8");
    assert(
      decBody.includes("capture_source: init-curator"),
      "Step 11: DEC frontmatter should carry capture_source: init-curator",
    );
    assert(
      decBody.includes("status: accepted"),
      "Step 11: DEC frontmatter should carry status: accepted",
    );
    console.log("  ✓ Step 11 — 9c-emit emits validated entries, drops the rest");
  }

  // ── Step 12 — 9d-comp-walk skips the whole component trio with no config ──
  {
    const repo = mkdtempSync(join(tmpdir(), "cairn-phase9d-"));
    cleanups.push(repo);
    execSync("git init -q", { cwd: repo });
    mkdirSync(join(repo, ".cairn"), { recursive: true });
    const fresh = freshPhaseState(repo);
    const r = await runPhase9dCompWalk({ ...fresh, currentPhase: "9d-comp-walk" });
    assert(r.status === "complete", `Step 12: 9d-comp-walk should complete, got ${r.status}`);
    if (r.status !== "complete") return;
    assert(
      r.nextPhase === "10-rules-merge",
      `Step 12: no-config should skip the trio to 10-rules-merge, got ${r.nextPhase}`,
    );
    assert(
      r.state.currentPhase === "10-rules-merge",
      `Step 12: persisted currentPhase should jump to 10-rules-merge, got ${r.state.currentPhase}`,
    );
    const out = r.state.outputs["9d-comp-walk"];
    assert(
      out?.skipped === "no-components",
      `Step 12: no-config repo should stamp skipped: no-components, got ${out?.skipped}`,
    );
    console.log("  ✓ Step 12 — 9d-comp-walk skips the trio cleanly without a components config");
  }

  console.log("smoke-init-phases-all — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})();
