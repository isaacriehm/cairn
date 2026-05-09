#!/usr/bin/env tsx
/**
 * smoke-self-adopt-skip — self-adopt phase short-circuit acceptance.
 *
 * When Phase 1 detect set `outputs["1-detect"].is_self_adopt = true`
 * (operator dogfooding via `CAIRN_SELF_ADOPT=1` against the Cairn
 * source repo), phases 8 / 9 / 10 / 12 must short-circuit so the
 * recursive-ingest scenario never runs against the source tree:
 *
 *   - Phase 8 (docs-ingest): would Haiku-classify Cairn's own docs/
 *   - Phase 9 (source-comments): would walk every essay-class block
 *     in Cairn's source (5-20 min)
 *   - Phase 10 (rules-merge): would Haiku-regen CLAUDE.md from
 *     extracted ground state — destroying the curated 150-line
 *     orientation file
 *   - Phase 12 (strip): would propose stripping the very comments
 *     that document Cairn's design
 *
 * Each runner short-circuits to status="complete" + nextPhase
 * pointing at the next live phase, with a skipped-marker stamped
 * into outputs so a future audit can see WHICH runs were short-
 * circuited.
 *
 * Steps:
 *   1. Phase 8 short-circuits → outputs["8-docs-ingest"].skipped="self-adopt"
 *   2. Phase 9 short-circuits → outputs["9-source-comments"].skipped="self-adopt"
 *   3. Phase 10 short-circuits → outputs["10-rules-merge"].skipped="self-adopt"
 *   4. Phase 12 short-circuits → no needs_input, advances to 13
 *   5. parallel-8910 short-circuits → all three outputs stamped, currentPhase advanced past 10
 *   6. Phase 1 detect sets is_self_adopt=true on a fixture marked as the Cairn source repo
 *   7. Phase 1 detect sets is_self_adopt=false on a non-Cairn repo
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshPhaseState,
  runPhase1Detect,
  runPhase8DocsIngest,
  runPhase9SourceComments,
  runPhase10RulesMerge,
  runPhase12Strip,
  runPhases8910Parallel,
  type PhaseResult,
  type PhaseState,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-self-adopt-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  return dir;
}

function mkSelfAdoptRepo(): string {
  // Simulate the Cairn source repo by seeding the markers
  // `isCairnSourceRepo()` looks for: pnpm-workspace.yaml +
  // packages/cairn-core/package.json (with name @isaacriehm/cairn-core)
  // + packages/cairn-frontend-claudecode/package.json.
  const dir = mkRepo();
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n",
  );
  mkdirSync(join(dir, "packages", "cairn-core"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "cairn-core", "package.json"),
    JSON.stringify({ name: "@isaacriehm/cairn-core", version: "0.0.0" }),
  );
  mkdirSync(join(dir, "packages", "cairn-frontend-claudecode"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "packages", "cairn-frontend-claudecode", "package.json"),
    JSON.stringify({ name: "cairn-fixture-frontend", version: "0.0.0" }),
  );
  return dir;
}

function selfAdoptState(
  repoRoot: string,
  currentPhase: PhaseState["currentPhase"],
): PhaseState {
  return {
    ...freshPhaseState(repoRoot),
    currentPhase,
    outputs: {
      "1-detect": { is_self_adopt: true },
    },
  } as PhaseState;
}

function expectComplete(
  result: PhaseResult,
  label: string,
): {
  state: PhaseState;
  nextPhase: PhaseResult extends { nextPhase: infer N } ? N : never;
} {
  if (result.status !== "complete") {
    fail(
      `${label}: expected status=complete, got ${result.status} ${JSON.stringify(result)}`,
    );
  }
  return { state: result.state, nextPhase: result.nextPhase as never };
}

async function main(): Promise<void> {
  console.log("smoke-self-adopt-skip — start");

  header("Step 1 — Phase 8 short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "8-docs-ingest");
    const result = await runPhase8DocsIngest(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 1");
    if (nextPhase !== "9-source-comments")
      fail(
        `Step 1: expected nextPhase=9-source-comments, got ${String(nextPhase)}`,
      );
    const out = next.outputs["8-docs-ingest"] as
      | { skipped?: string }
      | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 1: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 8 stamped skipped=self-adopt + advanced to 9-source-comments");
  }

  header("Step 2 — Phase 9 short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "9-source-comments");
    const result = await runPhase9SourceComments(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 2");
    if (nextPhase !== "10-rules-merge")
      fail(
        `Step 2: expected nextPhase=10-rules-merge, got ${String(nextPhase)}`,
      );
    const out = next.outputs["9-source-comments"] as
      | { skipped?: string }
      | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 2: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 9 stamped skipped=self-adopt + advanced to 10-rules-merge");
  }

  header("Step 3 — Phase 10 short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "10-rules-merge");
    const result = await runPhase10RulesMerge(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 3");
    if (nextPhase !== "11-baseline")
      fail(`Step 3: expected nextPhase=11-baseline, got ${String(nextPhase)}`);
    const out = next.outputs["10-rules-merge"] as
      | { skipped?: string }
      | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 3: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 10 stamped skipped=self-adopt + advanced to 11-baseline");
  }

  header("Step 4 — Phase 12 short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "12-strip");
    const result = await runPhase12Strip(state);
    if (result.status !== "complete") {
      fail(
        `Step 4: expected complete, got ${result.status} ${JSON.stringify(result)}`,
      );
    }
    const { state: next, nextPhase } = expectComplete(result, "Step 4");
    if (nextPhase !== "13-multidev")
      fail(`Step 4: expected nextPhase=13-multidev, got ${String(nextPhase)}`);
    const out = next.outputs["12-strip"] as {
      pending: unknown[];
      decisions: Record<string, unknown>;
    };
    if (out.pending.length !== 0)
      fail(
        `Step 4: pending should be empty on skip, got ${JSON.stringify(out.pending)}`,
      );
    if (Object.keys(out.decisions).length !== 0) {
      fail(
        `Step 4: decisions should be empty on skip, got ${JSON.stringify(out.decisions)}`,
      );
    }
    pass(
      "phase 12 short-circuited with empty pending + decisions, advanced to 13-multidev",
    );
  }

  header("Step 5 — parallel-8910 short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "8-docs-ingest");
    const result = await runPhases8910Parallel(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 5");
    if (nextPhase !== "11-baseline")
      fail(`Step 5: expected nextPhase=11-baseline, got ${String(nextPhase)}`);
    if (next.currentPhase !== "11-baseline") {
      fail(
        `Step 5: currentPhase should be advanced to 11-baseline, got ${next.currentPhase}`,
      );
    }
    for (const id of [
      "8-docs-ingest",
      "9-source-comments",
      "10-rules-merge",
    ] as const) {
      const out = next.outputs[id] as { skipped?: string } | undefined;
      if (out?.skipped !== "self-adopt")
        fail(`Step 5: ${id} not stamped, got ${JSON.stringify(out)}`);
    }
    pass("parallel-8910 stamped all 3 outputs + advanced to 11-baseline");
  }

  header(
    "Step 6 — Phase 1 detect sets is_self_adopt=true on Cairn-source fixture w/ CAIRN_SELF_ADOPT=1",
  );
  {
    const repo = mkSelfAdoptRepo();
    const previousFlag = process.env["CAIRN_SELF_ADOPT"];
    process.env["CAIRN_SELF_ADOPT"] = "1";
    try {
      const result = await runPhase1Detect(freshPhaseState(repo));
      if (result.status !== "complete")
        fail(`Step 6: expected complete, got ${JSON.stringify(result)}`);
      const detect = result.state.outputs["1-detect"] as {
        is_self_adopt?: boolean;
      };
      if (detect.is_self_adopt !== true) {
        fail(
          `Step 6: expected is_self_adopt=true, got ${JSON.stringify(detect.is_self_adopt)}`,
        );
      }
      pass("Phase 1 detect stamped is_self_adopt=true on Cairn fixture");
    } finally {
      if (previousFlag === undefined) delete process.env["CAIRN_SELF_ADOPT"];
      else process.env["CAIRN_SELF_ADOPT"] = previousFlag;
    }
  }

  header("Step 7 — Phase 1 detect sets is_self_adopt=false on non-Cairn repo");
  {
    const repo = mkRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "totally-not-cairn", version: "0.0.0" }),
    );
    const result = await runPhase1Detect(freshPhaseState(repo));
    if (result.status !== "complete")
      fail(`Step 7: expected complete, got ${JSON.stringify(result)}`);
    const detect = result.state.outputs["1-detect"] as {
      is_self_adopt?: boolean;
    };
    if (detect.is_self_adopt !== false) {
      fail(
        `Step 7: expected is_self_adopt=false, got ${JSON.stringify(detect.is_self_adopt)}`,
      );
    }
    pass("Phase 1 detect stamped is_self_adopt=false on non-Cairn fixture");
  }

  console.log("\nsmoke-self-adopt-skip — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
