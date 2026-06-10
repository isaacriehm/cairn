#!/usr/bin/env tsx
/**
 * smoke-self-adopt-skip — self-adopt phase short-circuit acceptance
 * (v0.9.0 — curator pipeline rewrite).
 *
 * When Phase 1 detect set `outputs["1-detect"].is_self_adopt = true`
 * (operator dogfooding via `CAIRN_SELF_ADOPT=1` against the Cairn
 * source repo), the curator pipeline (9a/9b/9c) and Phase 12 strip
 * must short-circuit so the recursive-ingest scenario never runs
 * against the source tree:
 *
 *   - Phase 9a-walker: would walk every essay-class block in Cairn's
 *     own source (5-20 min on busy monorepos)
 *   - Phase 9b-curate: would dispatch Sonnet subagents over Cairn's
 *     own corpus
 *   - Phase 9c-emit: would write extracted DECs over Cairn's own
 *     ground state
 *   - Phase 12 (strip): would propose stripping the very comments
 *     that document Cairn's design
 *
 * Phase 8-docs-ingest and Phase 10-rules-merge are unconditional no-op
 * markers in v0.9.0 — they always stamp `skipped:
 * "merged-into-9-curator"` without consulting the self-adopt flag.
 *
 * Steps:
 *   1. Phase 9a short-circuits → outputs["9a-walker"].skipped="self-adopt"
 *   2. Phase 9b short-circuits → outputs["9b-curate"].skipped="self-adopt"
 *   3. Phase 9c short-circuits → outputs["9c-emit"].skipped="self-adopt"
 *   4. Phase 12 short-circuits → no needs_input, advances to 13
 *   5. Phase 8 + 10 stamp `merged-into-9-curator` regardless of
 *      self-adopt (no-op markers, advance the state machine)
 *   6. Phase 1 detect sets is_self_adopt=true on a fixture marked as
 *      the Cairn source repo
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
  runPhase9aWalker,
  runPhase9bCurate,
  runPhase9cEmit,
  runPhase10RulesMerge,
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

  header("Step 1 — Phase 9a-walker short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "9a-walker");
    const result = await runPhase9aWalker(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 1");
    if (nextPhase !== "9b-curate")
      fail(`Step 1: expected nextPhase=9b-curate, got ${String(nextPhase)}`);
    const out = next.outputs["9a-walker"] as { skipped?: string } | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 1: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 9a-walker stamped skipped=self-adopt + advanced to 9b-curate");
  }

  header("Step 2 — Phase 9b-curate short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "9b-curate");
    const result = await runPhase9bCurate(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 2");
    if (nextPhase !== "9c-emit")
      fail(`Step 2: expected nextPhase=9c-emit, got ${String(nextPhase)}`);
    const out = next.outputs["9b-curate"] as { skipped?: string } | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 2: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 9b-curate stamped skipped=self-adopt + advanced to 9c-emit");
  }

  header("Step 3 — Phase 9c-emit short-circuits on is_self_adopt");
  {
    const repo = mkRepo();
    const state = selfAdoptState(repo, "9c-emit");
    const result = await runPhase9cEmit(state);
    const { state: next, nextPhase } = expectComplete(result, "Step 3");
    if (nextPhase !== "10-rules-merge")
      fail(`Step 3: expected nextPhase=10-rules-merge, got ${String(nextPhase)}`);
    const out = next.outputs["9c-emit"] as { skipped?: string } | undefined;
    if (out?.skipped !== "self-adopt")
      fail(`Step 3: expected skipped=self-adopt, got ${JSON.stringify(out)}`);
    pass("phase 9c-emit stamped skipped=self-adopt + advanced to 10-rules-merge");
  }

  header("Step 5 — Phase 8 + 10 stamp merged-into-9-curator regardless of self-adopt");
  {
    const repo = mkRepo();
    const state8 = selfAdoptState(repo, "8-docs-ingest");
    const r8 = await runPhase8DocsIngest(state8);
    const { state: after8, nextPhase: next8 } = expectComplete(r8, "Step 5/8");
    if (next8 !== "9a-walker")
      fail(`Step 5: phase 8 expected nextPhase=9a-walker, got ${String(next8)}`);
    const out8 = after8.outputs["8-docs-ingest"] as { skipped?: string } | undefined;
    if (out8?.skipped !== "merged-into-9-curator")
      fail(`Step 5: phase 8 expected skipped=merged-into-9-curator, got ${JSON.stringify(out8)}`);

    const state10 = selfAdoptState(repo, "10-rules-merge");
    const r10 = await runPhase10RulesMerge(state10);
    const { state: after10, nextPhase: next10 } = expectComplete(r10, "Step 5/10");
    if (next10 !== "11-baseline")
      fail(`Step 5: phase 10 expected nextPhase=11-baseline, got ${String(next10)}`);
    const out10 = after10.outputs["10-rules-merge"] as { skipped?: string } | undefined;
    if (out10?.skipped !== "merged-into-9-curator")
      fail(`Step 5: phase 10 expected skipped=merged-into-9-curator, got ${JSON.stringify(out10)}`);
    pass("phase 8 + 10 stamped merged-into-9-curator markers, self-adopt bypassed");
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
