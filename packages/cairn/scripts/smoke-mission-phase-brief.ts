#!/usr/bin/env tsx
/**
 * smoke-mission-phase-brief — E2E of the just-in-time per-phase brief
 * lifecycle against a real `.cairn/` on disk. Drives the actual
 * `cairn-state` writers + the compiled `cairn_mission_plan_phase` /
 * `cairn_mission_get` / cursor-advance handlers — no mocks.
 *
 * Lifecycle covered:
 *   1. Fresh mission → cursor phase is brief-pending (`brief_status:
 *      null` from mission_get).
 *   2. `cairn_mission_plan_phase` writes the committed brief file,
 *      stamps `brief_status: accepted`, journals `phase-brief-set`.
 *   3. mission_get surfaces `active_phase_brief_status: "accepted"`
 *      and the brief decisions/constraints/acceptance.
 *   4. Brief file round-trips through serialize → parse (readPhaseBrief).
 *   5. Cursor advance lands phase-2 brief-pending again — every phase
 *      re-gates (smart-gate invariant).
 *   6. Autonomous plan_phase stamps `autonomous: true` in the brief.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const STATE_DIST = join(REPO_ROOT, "packages", "cairn-state", "dist", "index.js");
const TOOLS_DIST = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "dist",
  "mcp",
  "tools",
);

const MISSION_ID = "MIS-test-1234567";
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

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-mission-brief-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.3.0\n", "utf8");
  return dir;
}

async function main(): Promise<void> {
  console.log("smoke-mission-phase-brief — start");
  assert(existsSync(STATE_DIST), `expected compiled cairn-state at ${STATE_DIST} (run pnpm -r build)`);

  const state = await import(STATE_DIST);
  // Import the tools barrel as the entrypoint so ESM resolves the whole
  // module graph in dependency order before we read the bindings —
  // importing individual tool files trips a partial-init cycle. The
  // barrel exposes `allTools`; pick the handlers by name.
  const { allTools } = await import(join(TOOLS_DIST, "index.js"));
  const byName = (n: string) => {
    const t = allTools.find((tool: any) => tool.name === n);
    assert(t, `tool ${n} must be registered`);
    return t;
  };
  const missionPlanPhaseTool = byName("cairn_mission_plan_phase");
  const missionGetTool = byName("cairn_mission_get");
  const { advanceMissionPhase } = await import(
    join(REPO_ROOT, "packages", "cairn-core", "dist", "missions", "index.js")
  );

  const repo = mkRepoRoot();
  const ctx = { repoRoot: repo };
  const startedAt = new Date().toISOString();

  // Seed a 2-phase mission through the real state writers.
  const frontmatter = {
    mission_id: MISSION_ID,
    title: "Brief lifecycle mission",
    spec_path: ".cairn/missions/_drafts/brief.md",
    created_at: startedAt,
    exit_gate: "prompt" as const,
    phases: [
      { id: "phase-1-schema", title: "Schema", depends_on: [], exit_criteria: "Migration applied." },
      { id: "phase-2-api", title: "API", depends_on: ["phase-1-schema"], exit_criteria: "Routes smoke green." },
    ],
  };
  state.writeRoadmap(repo, MISSION_ID, frontmatter, "# Mission\n");
  state.writeMissionSpec(repo, MISSION_ID, "# Brief\n\n## Schema\n\nSeed.\n\n## API\n\nSeed.\n");
  const phaseProgress = state.initialPhaseProgress(frontmatter);
  phaseProgress["phase-1-schema"] = { state: "in_progress", task_ids: [] };
  state.writeMissionState(repo, MISSION_ID, {
    mission_id: MISSION_ID,
    started_at: startedAt,
    cursor: { active_phase: "phase-1-schema", active_phase_started_at: startedAt },
    phase_progress: phaseProgress,
    outcome: "active",
  });

  // ── Step 1 — fresh mission: cursor phase is brief-pending
  {
    const got = (await missionGetTool.handler(ctx, {})) as Record<string, any>;
    assert(got.active === true, "Step 1 — mission should be active");
    assert(
      got.cursor.active_phase_brief_status === null,
      `Step 1 — fresh phase must be brief-pending (got ${got.cursor.active_phase_brief_status})`,
    );
    assert(
      got.cursor.active_phase_brief === null,
      "Step 1 — no brief object before tightening",
    );
    console.log("  ✓ Step 1 — fresh cursor phase is brief-pending");
  }

  // ── Step 2 — plan_phase writes the brief + stamps brief_status
  {
    const res = (await missionPlanPhaseTool.handler(ctx, {
      decisions: [
        { question: "FK style?", choice: "uuid", rationale: "matches §INV-1" },
      ],
      constraints: ["All tables carry created_at (§INV-1)."],
      acceptance: ["Migration applies clean on empty DB."],
      cite_invariants: ["INV-1"],
    })) as Record<string, any>;
    assert(res.ok === true, `Step 2 — plan_phase should succeed: ${JSON.stringify(res)}`);
    assert(res.phase_id === "phase-1-schema", "Step 2 — defaults to cursor phase");
    assert(res.brief_status === "accepted", "Step 2 — default status accepted");
    const briefPath = join(repo, ".cairn", "ground", "missions", MISSION_ID, "briefs", "phase-1-schema.md");
    assert(existsSync(briefPath), "Step 2 — committed brief file must exist");
    const journal = state.readMissionJournal(repo, MISSION_ID);
    assert(
      journal.some((e: any) => e.kind === "phase-brief-set" && e.phase_id === "phase-1-schema"),
      "Step 2 — journal records phase-brief-set",
    );
    console.log("  ✓ Step 2 — plan_phase writes brief + journals");
  }

  // ── Step 3 — mission_get surfaces accepted brief + decisions
  {
    const got = (await missionGetTool.handler(ctx, {})) as Record<string, any>;
    assert(
      got.cursor.active_phase_brief_status === "accepted",
      "Step 3 — brief_status now accepted",
    );
    assert(
      got.cursor.active_phase_brief?.decisions?.[0]?.choice === "uuid",
      "Step 3 — surfaced brief carries the decision",
    );
    assert(
      got.cursor.active_phase_brief?.constraints?.length === 1,
      "Step 3 — surfaced brief carries constraints",
    );
    console.log("  ✓ Step 3 — mission_get surfaces accepted brief");
  }

  // ── Step 4 — brief file round-trips through readPhaseBrief
  {
    const brief = state.readPhaseBrief(repo, MISSION_ID, "phase-1-schema");
    assert(brief !== null, "Step 4 — readPhaseBrief returns the brief");
    assert(brief.acceptance[0] === "Migration applies clean on empty DB.", "Step 4 — acceptance round-trips");
    assert(brief.cite_invariants[0] === "INV-1", "Step 4 — cites round-trip");
    console.log("  ✓ Step 4 — brief serialize/parse round-trips");
  }

  // ── Step 5 — advancing the cursor re-gates phase-2 (brief-pending)
  {
    const adv = advanceMissionPhase(repo, MISSION_ID, "phase-1-schema");
    assert(adv.ok === true, `Step 5 — advance should succeed: ${JSON.stringify(adv)}`);
    assert(adv.next_phase?.id === "phase-2-api", "Step 5 — cursor moves to phase-2");
    const got = (await missionGetTool.handler(ctx, {})) as Record<string, any>;
    assert(got.cursor.active_phase === "phase-2-api", "Step 5 — cursor on phase-2");
    assert(
      got.cursor.active_phase_brief_status === null,
      "Step 5 — phase-2 is brief-pending — every phase re-gates",
    );
    console.log("  ✓ Step 5 — advance re-gates the next phase");
  }

  // ── Step 6 — autonomous plan_phase stamps autonomous
  {
    const res = (await missionPlanPhaseTool.handler(ctx, {
      autonomous: true,
      decisions: [{ question: "Pagination?", choice: "cursor-based" }],
    })) as Record<string, any>;
    assert(res.ok === true && res.phase_id === "phase-2-api", "Step 6 — autonomous plan on phase-2");
    const brief = state.readPhaseBrief(repo, MISSION_ID, "phase-2-api");
    assert(brief?.autonomous === true, "Step 6 — brief flagged autonomous");
    console.log("  ✓ Step 6 — autonomous brief flagged for audit");
  }

  // ── Step 7 — multi-dev: brief FILE drives status without clone flag
  {
    // Simulate a teammate clone — the committed brief file is present
    // but the per-clone `brief_status` flag (gitignored state.json) is
    // not. mission_get must still report `accepted` off the file.
    const st = state.readMissionState(repo, MISSION_ID);
    delete st.phase_progress["phase-2-api"].brief_status;
    state.writeMissionState(repo, MISSION_ID, st);
    const got = (await missionGetTool.handler(ctx, {})) as Record<string, any>;
    assert(got.cursor.active_phase === "phase-2-api", "Step 7 — cursor still phase-2");
    assert(
      got.cursor.active_phase_brief_status === "accepted",
      `Step 7 — brief file must drive status without clone flag (got ${got.cursor.active_phase_brief_status})`,
    );
    console.log("  ✓ Step 7 — committed brief file is canonical (multi-dev)");
  }

  console.log("smoke-mission-phase-brief — pass");
  cleanup();
}

main().catch((err) => {
  console.error("✗ smoke-mission-phase-brief failed:", err);
  cleanup();
  process.exit(1);
});
