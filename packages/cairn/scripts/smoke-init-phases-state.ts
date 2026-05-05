#!/usr/bin/env tsx
/**
 * smoke-init-phases-state — verify the v0.2.0 init phase orchestrator's
 * read/write/resume contract against a temp repo root.
 *
 * The cairn-adopt skill driver depends on this contract being stable
 * across plugin upgrades — state files written by one version must be
 * readable by the next. The smoke covers schema validation, the fresh-
 * start path, persisted-resume, and the phase advance helpers.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE_IDS,
  advancePhase,
  clearPhaseState,
  freshPhaseState,
  nextPhaseAfter,
  phaseStateAbsPath,
  readPhaseState,
  resumePhases,
  writePhaseState,
  type PhaseState,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-init-phases-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-init-phases-state — start");

  // ── Step 1 — freshPhaseState shape ───────────────────────────────
  {
    const repo = mkRepo();
    const state = freshPhaseState(repo);
    assert(state.repoRoot === repo, `Step 1: repoRoot mismatch, got ${state.repoRoot}`);
    assert(state.currentPhase === "1-detect", `Step 1: first phase must be 1-detect, got ${state.currentPhase}`);
    assert(state.schemaVersion === 1, `Step 1: schemaVersion must be 1, got ${state.schemaVersion}`);
    assert(typeof state.startedAt === "string" && state.startedAt.length > 0, "Step 1: startedAt missing");
    assert(Object.keys(state.outputs).length === 0, "Step 1: outputs should be empty initially");
    console.log("  ✓ Step 1 — freshPhaseState shape");
  }

  // ── Step 2 — resumePhases on empty repo → ready / 1-detect ──────
  {
    const repo = mkRepo();
    const r = resumePhases(repo);
    assert(r.status === "ready", `Step 2: empty repo should report 'ready', got ${r.status}`);
    assert(r.nextPhase === "1-detect", `Step 2: nextPhase should be 1-detect, got ${r.nextPhase}`);
    assert(r.state.currentPhase === "1-detect", "Step 2: state.currentPhase should be 1-detect");
    console.log("  ✓ Step 2 — resumePhases on fresh repo → ready / 1-detect");
  }

  // ── Step 3 — write/read round-trip ───────────────────────────────
  {
    const repo = mkRepo();
    const original: PhaseState = {
      ...freshPhaseState(repo),
      currentPhase: "5-brand",
      outputs: { "1-detect": { stack: "node" }, "4-pilot": "src/auth" },
      answer: "a",
    };
    const path = writePhaseState(original);
    assert(existsSync(path), `Step 3: state file ${path} should exist after write`);
    const round = readPhaseState(repo);
    assert(round !== null, "Step 3: read returned null after write");
    assert(round!.currentPhase === "5-brand", `Step 3: currentPhase round-trip failed, got ${round!.currentPhase}`);
    assert(round!.answer === "a", `Step 3: answer round-trip failed, got ${round!.answer}`);
    const detect = round!.outputs["1-detect"] as { stack: string };
    assert(detect.stack === "node", `Step 3: outputs round-trip failed`);
    console.log("  ✓ Step 3 — writePhaseState ⇄ readPhaseState round-trip");
  }

  // ── Step 4 — resumePhases reads persisted state + returns next ───
  {
    const repo = mkRepo();
    writePhaseState({
      ...freshPhaseState(repo),
      currentPhase: "3-mapper",
    });
    const r = resumePhases(repo);
    assert(r.status === "ready", `Step 4: should report ready, got ${r.status}`);
    assert(r.nextPhase === "3b-seed", `Step 4: after 3-mapper next should be 3b-seed, got ${r.nextPhase}`);
    assert(r.state.currentPhase === "3-mapper", "Step 4: state should preserve currentPhase");
    console.log("  ✓ Step 4 — resumePhases reads persisted state + advances");
  }

  // ── Step 5 — last phase reports done with nextPhase=null ─────────
  {
    const repo = mkRepo();
    writePhaseState({
      ...freshPhaseState(repo),
      currentPhase: "12-multidev",
    });
    const r = resumePhases(repo);
    assert(r.status === "done", `Step 5: terminal phase should report done, got ${r.status}`);
    assert(r.nextPhase === null, `Step 5: terminal nextPhase should be null, got ${r.nextPhase}`);
    console.log("  ✓ Step 5 — terminal phase → done / null");
  }

  // ── Step 6 — schema validation rejects malformed state ──────────
  {
    const repo = mkRepo();
    const path = phaseStateAbsPath(repo);
    // Manually write a busted file (pre-create .cairn dir).
    writePhaseState(freshPhaseState(repo));
    writeFileSync(path, JSON.stringify({ schemaVersion: 999, repoRoot: repo }), "utf8");
    const r = readPhaseState(repo);
    assert(r === null, `Step 6: malformed state should return null, got ${JSON.stringify(r)}`);
    console.log("  ✓ Step 6 — readPhaseState rejects malformed state");
  }

  // ── Step 7 — clearPhaseState removes the file ────────────────────
  {
    const repo = mkRepo();
    writePhaseState(freshPhaseState(repo));
    assert(existsSync(phaseStateAbsPath(repo)), "Step 7: state file should exist before clear");
    clearPhaseState(repo);
    assert(!existsSync(phaseStateAbsPath(repo)), "Step 7: state file should be removed after clear");
    // Idempotent: clearing twice is fine.
    clearPhaseState(repo);
    console.log("  ✓ Step 7 — clearPhaseState idempotent removal");
  }

  // ── Step 8 — phase walk helpers (nextPhaseAfter / advancePhase) ──
  {
    // Walk every id; nextPhaseAfter must match PHASE_IDS sequence.
    for (let i = 0; i < PHASE_IDS.length; i++) {
      const cur = PHASE_IDS[i]!;
      const next = nextPhaseAfter(cur);
      const expected = i === PHASE_IDS.length - 1 ? null : (PHASE_IDS[i + 1] ?? null);
      assert(
        next === expected,
        `Step 8: nextPhaseAfter(${cur}) should be ${expected}, got ${next}`,
      );
    }
    const repo = mkRepo();
    let s = freshPhaseState(repo);
    for (let i = 1; i < PHASE_IDS.length; i++) {
      s = advancePhase(s);
      assert(
        s.currentPhase === PHASE_IDS[i],
        `Step 8: advancePhase iter ${i} should land on ${PHASE_IDS[i]}, got ${s.currentPhase}`,
      );
      assert(s.answer === undefined, "Step 8: advancePhase should clear answer");
    }
    // Past terminal: stays put.
    const past = advancePhase(s);
    assert(past.currentPhase === "12-multidev", "Step 8: advancePhase past terminal should be a no-op");
    console.log("  ✓ Step 8 — phase walk helpers");
  }

  console.log("smoke-init-phases-state — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
