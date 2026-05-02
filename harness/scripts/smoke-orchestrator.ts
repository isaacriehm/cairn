#!/usr/bin/env tsx
/**
 * smoke-orchestrator — Phase 8 acceptance sensor.
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 8:
 *   "dry-run with hard-coded task ('create file harness/scratch/echo.txt
 *    with HELLO'); verify mirror modified, file exists, run row reflects
 *    `succeeded`, no commit yet (waiting on UAT or auto-merge gate)."
 *
 * Costs ~one cheap `claude` call (~$0.05 of haiku quota). SKIPS when the
 * `claude` CLI is missing or not authenticated.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInboxRow } from "../src/frontend/index.js";
import { StubFrontendAdapter } from "../src/frontend/stub/index.js";
import { claudeIsAvailable } from "../src/claude/index.js";
import {
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
} from "../src/mirror/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";

const projectName = `smoke_orch_${Date.now()}`;
let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-orchestrator FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function skip(reason: string): never {
  console.log(`smoke-orchestrator SKIP: ${reason}`);
  cleanup();
  process.exit(0);
}

function cleanup(): void {
  const recordPath = mirrorRecordPath(projectName);
  const clonePath = mirrorPath(projectName);
  for (const p of [recordPath, clonePath, ...cleanupPaths]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function pollFor<T>(
  fn: () => T | undefined,
  opts: { timeoutMs: number; intervalMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`timed out waiting for ${opts.what} (after ${opts.timeoutMs}ms)`);
}

async function main(): Promise<void> {
  if (!claudeIsAvailable()) {
    skip("`claude` CLI not on PATH or not authenticated — install Claude Code and sign in");
  }

  const root = mkdtempSync(join(tmpdir(), "harness-smoke-orch-"));
  cleanupPaths.push(root);
  const originBare = join(root, "origin.git");
  const userTree = join(root, "user-tree");

  header("Step 1: bare origin + user-tree seed");
  mkdirSync(originBare);
  execSync("git init --bare -b main", { cwd: originBare });
  mkdirSync(userTree);
  execSync("git init -b main", { cwd: userTree });
  execSync("git config user.email smoke@harness.local", { cwd: userTree });
  execSync("git config user.name smoke", { cwd: userTree });
  writeFileSync(join(userTree, "README.md"), "smoke\n");
  // Pre-create the scratch dir so the agent doesn't need to mkdir it.
  mkdirSync(join(userTree, "harness", "scratch"), { recursive: true });
  writeFileSync(join(userTree, "harness", "scratch", ".gitkeep"), "");
  // Pre-write a workflow.md so the orchestrator's prompt loader has something
  // realistic; otherwise it falls back to its inline default which is fine
  // too. Smoke prefers the realistic path.
  mkdirSync(join(userTree, ".harness", "config"), { recursive: true });
  writeFileSync(
    join(userTree, ".harness", "config", "workflow.md"),
    [
      "---",
      "type: workflow-policy",
      "verified-at: 2026-05-02T00:00:00Z",
      "---",
      "",
      "## Identity",
      "You are running inside the harness as `{{agent_role}}` for `{{project_name}}`. Run-id `{{run_id}}`. Mirror at `{{mirror_path}}` pinned to SHA `{{sha_pin}}`. Do not commit, do not push.",
      "",
      "## Task",
      "{{tightened_spec_body}}",
      "",
      "## Acceptance",
      "{{#each acceptance_criteria}}",
      "- {{this}}",
      "{{/each}}",
      "",
      "## Constraints",
      "Edit only inside the mirror. Do not commit or push.",
      "",
    ].join("\n"),
  );
  execSync("git add -A && git commit -m initial", { cwd: userTree });
  execSync(`git remote add origin ${originBare}`, { cwd: userTree });
  execSync("git push -u origin main", { cwd: userTree });

  header("Step 2: ensureMirror");
  const record = await ensureMirror({
    projectName,
    userTreePath: userTree,
    originUrl: originBare,
  });
  const mirror = record.mirrorPath;

  header("Step 3: drop task row to inbox");
  await writeInboxRow({
    repoRoot: mirror,
    source: "smoke",
    kind: "task",
    payload: {
      task: {
        rawText:
          "Create file `harness/scratch/echo.txt` containing exactly the single word HELLO and a trailing newline. Do not modify any other file.",
        intent: "code_task",
        authorId: "smoke-runner",
      },
      task_id: "TSK-smoke-orch-1",
      title: "create scratch/echo.txt with HELLO",
      acceptance_criteria: [
        "harness/scratch/echo.txt exists in the mirror after the run",
        "Its contents are exactly: HELLO\\n",
        "No other file under the mirror is modified",
      ],
    },
  });

  header("Step 4: start orchestrator (haiku, bypassTightener=true)");
  const stub = new StubFrontendAdapter({ repoRoot: mirror });
  await stub.start();
  const orchestrator = new Orchestrator({
    projectName,
    repoRoot: mirror,
    adapters: [stub],
    bypassTightener: true,
    // Phase 8 smoke pre-dates the attestation contract; sensors live behind
    // smoke-sensors.ts (Phase 9), reviewer behind smoke-reviewer.ts (Phase 10),
    // UAT behind smoke-uat.ts (Phase 11). Keep this smoke narrow so it stays
    // cheap.
    bypassSensors: true,
    bypassReviewer: true,
    bypassUat: true,
    defaultTier: "haiku",
    pollIntervalMs: 500,
    runTimeoutMs: 300_000,
  });
  await orchestrator.start();

  header("Step 5: wait for run completion");
  const runsDir = join(mirror, ".harness", "runs", "active");
  const meta = await pollFor(
    () => {
      if (!existsSync(runsDir)) return undefined;
      const dirs = readdirSync(runsDir).filter((d) => d.startsWith("run-"));
      for (const d of dirs) {
        const metaPath = join(runsDir, d, "meta.json");
        if (!existsSync(metaPath)) continue;
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        if (m["phase"] === "succeeded" || m["phase"] === "failed") {
          return { runId: d, meta: m };
        }
      }
      return undefined;
    },
    { timeoutMs: 360_000, intervalMs: 1000, what: "run completion" },
  );
  console.log(
    `  run_id=${meta.runId} phase=${meta.meta["phase"]} events=${meta.meta["events_count"]} duration=${meta.meta["duration_ms"]}ms`,
  );

  // Diagnostic: dump non-partial events + result body on failure.
  const dumpEvents = (): void => {
    const eventsPath = join(runsDir, meta.runId, "events.jsonl");
    if (!existsSync(eventsPath)) {
      console.error("  (no events.jsonl on disk)");
      return;
    }
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
    console.error(`  events.jsonl has ${lines.length} lines.`);
    let assistantTexts = 0;
    for (const line of lines) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e["type"] === "stream_event") continue;
      const typeStr = `type=${e["type"]} subtype=${e["subtype"] ?? ""}`;
      if (e["type"] === "assistant") {
        const msg = e["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
        const summary = (content ?? [])
          .map((c) => {
            if (c["type"] === "text") {
              return `text:${String(c["text"]).slice(0, 100)}`;
            }
            if (c["type"] === "tool_use") {
              return `tool_use:${String(c["name"])}(${JSON.stringify(c["input"]).slice(0, 80)})`;
            }
            return `${c["type"]}`;
          })
          .join(" | ");
        console.error(`    ${typeStr} ${summary}`);
        assistantTexts += 1;
      } else if (e["type"] === "user") {
        const msg = e["message"] as Record<string, unknown> | undefined;
        const content = msg?.["content"] as Array<Record<string, unknown>> | undefined;
        const summary = (content ?? [])
          .map((c) => `${c["type"]}:${JSON.stringify(c).slice(0, 80)}`)
          .join(" | ");
        console.error(`    ${typeStr} ${summary}`);
      } else if (e["type"] === "result") {
        console.error(
          `    ${typeStr} is_error=${e["is_error"]} result=${String(e["result"]).slice(0, 200)}`,
        );
      } else {
        console.error(`    ${typeStr}`);
      }
    }
    console.error(`  assistant turns: ${assistantTexts}`);
  };

  if (meta.meta["phase"] !== "succeeded") {
    dumpEvents();
    fail(`run ended in phase ${meta.meta["phase"]}: ${String(meta.meta["error"] ?? "")}`);
  }

  header("Step 6: assert echo.txt in mirror");
  const echoPath = join(mirror, "harness", "scratch", "echo.txt");
  if (!existsSync(echoPath)) {
    dumpEvents();
    fail(`expected ${echoPath} after run`);
  }
  const echoBody = readFileSync(echoPath, "utf8");
  if (!/^HELLO\s*$/.test(echoBody.trim())) {
    fail(`echo.txt body unexpected: ${JSON.stringify(echoBody)}`);
  }
  console.log(`  echo.txt = ${JSON.stringify(echoBody)}`);

  header("Step 7: assert events.jsonl populated");
  const eventsPath = join(runsDir, meta.runId, "events.jsonl");
  if (!existsSync(eventsPath)) fail(`expected ${eventsPath}`);
  const eventLines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  if (eventLines.length < 3) fail(`events.jsonl too small: ${eventLines.length} lines`);
  // The final event must be the result envelope.
  const last = JSON.parse(eventLines[eventLines.length - 1] ?? "{}") as Record<string, unknown>;
  if (last["type"] !== "result") fail(`expected last event type=result, got ${last["type"]}`);
  console.log(`  events.jsonl = ${eventLines.length} lines, last type=${last["type"]}`);

  header("Step 8: assert no commit landed");
  const mirrorHead = execSync("git rev-parse HEAD", { cwd: mirror }).toString().trim();
  const originHead = execSync("git rev-parse HEAD", { cwd: originBare }).toString().trim();
  if (mirrorHead !== originHead) {
    fail(
      `mirror HEAD ${mirrorHead.slice(0, 8)} != origin HEAD ${originHead.slice(0, 8)} — agent committed when it shouldn't have`,
    );
  }

  header("Step 9: stop + cleanup");
  await orchestrator.stop();
  await stub.stop();
  cleanup();
  console.log("\nsmoke-orchestrator: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
