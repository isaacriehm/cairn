#!/usr/bin/env tsx
/**
 * smoke-bug-mine-0.13.10 — Phase 7: soft-truncate schema-reject hard stops.
 *
 * Spec: docs/bug-mine-r3/PHASES.md Phase 7.
 *
 * Scenarios:
 *   1. `cairn_task_create` with a 200-char title succeeds, response
 *      carries `truncated: ["title"]`, and the on-disk spec.tightened.md
 *      / status.yaml hold the truncated value with a trailing marker.
 *   2. `cairn_task_create` with a normal (≤80 char) title carries no
 *      `truncated` key.
 *   3. `cairn_task_journal_append` with 35 paths succeeds, returns
 *      `truncated: ["files_touched"]` + `dropped.files_touched` with
 *      the trailing 15, and the journal entry holds exactly 20 paths.
 *   4. `cairn_task_journal_append` with 12 paths carries no truncation
 *      and the journal entry holds all 12.
 */

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
  allTools,
  type McpContext,
  type ToolDef,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-bugmine-01310-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "ground", "invariants"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "active"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "done"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "events"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "config"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "manifest.yaml"),
    "cairn_version: 0.13.10\nbootstrap_complete: true\n",
    "utf8",
  );
  return dir;
}

function getTool(name: string): ToolDef<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find((t) => t.name === name);
  assert(tool !== undefined, `${name} should be registered in allTools`);
  return tool;
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<Record<string, unknown>> {
  return (await tool.handler(ctx, input)) as Record<string, unknown>;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-bug-mine-0.13.10 — start");

  const repoRoot = mkRepoRoot();
  const ctx: McpContext = { repoRoot, sessionId: "smoke-soft-trunc" };
  const createTool = getTool("cairn_task_create");
  const journalTool = getTool("cairn_task_journal_append");

  // Scenario 1 — long title soft-truncates.
  const longTitle =
    "Soft-truncate hard-stop schema rejects covering task-create title plus task-journal-append files-touched plus the AskUserQuestion four-option ceiling rule";
  assert(longTitle.length > 80, `fixture title sanity: ${longTitle.length}`);
  const created = await call(createTool, ctx, {
    slug: "phase-7-long-title",
    title: longTitle,
    goal: "Verify long titles soft-truncate at the handler instead of rejecting.",
    mission_id: "",
  });
  assert(
    typeof created["task_id"] === "string",
    `Scenario 1 — task_create should succeed with a long title; got ${JSON.stringify(created)}`,
  );
  const taskId = created["task_id"] as string;
  const truncatedFields = created["truncated"];
  assert(
    Array.isArray(truncatedFields) && truncatedFields.includes("title"),
    `Scenario 1 — response should carry truncated:["title"]; got ${JSON.stringify(created)}`,
  );
  const activeDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  const spec = readFileSync(join(activeDir, "spec.tightened.md"), "utf8");
  const status = readFileSync(join(activeDir, "status.yaml"), "utf8");
  const titleMatch = spec.match(/^title:\s*(.+)$/m);
  assert(
    titleMatch !== null && titleMatch[1] !== undefined,
    `Scenario 1 — spec frontmatter missing title row;\n${spec}`,
  );
  const writtenTitle = (titleMatch![1] ?? "").trim().replace(/^['"]|['"]$/g, "");
  assert(
    writtenTitle.length <= 80,
    `Scenario 1 — written title should be ≤80 chars, got ${writtenTitle.length}: ${writtenTitle}`,
  );
  assert(
    /…\[\+\d+ chars truncated\]$/.test(writtenTitle),
    `Scenario 1 — truncated title should end in …[+N chars truncated] marker; got "${writtenTitle}"`,
  );
  assert(
    new RegExp(`title:\\s*${writtenTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(status),
    `Scenario 1 — status.yaml title should match the truncated value;\n${status}`,
  );
  console.log("  ✓ Scenario 1 — 200-char title soft-truncates at the word boundary");

  // Scenario 2 — normal title carries no truncated key.
  const createdShort = await call(createTool, ctx, {
    slug: "phase-7-short-title",
    title: "Short title fits under the cap",
    goal: "Verify short titles do not carry the truncated marker.",
    mission_id: "",
  });
  assert(
    createdShort["truncated"] === undefined,
    `Scenario 2 — short title should not carry truncated; got ${JSON.stringify(createdShort)}`,
  );
  console.log("  ✓ Scenario 2 — short title response has no truncated key");

  // Scenario 3 — files_touched=35 keeps the first 20, drops the rest.
  const paths35 = Array.from({ length: 35 }, (_, i) => `src/mod${String(i + 1).padStart(2, "0")}.ts`);
  const appended = await call(journalTool, ctx, {
    task_id: taskId,
    summary: "Phase 7 soft-truncate smoke — files_touched=35.",
    files_touched: paths35,
  });
  assert(
    appended["ok"] === true,
    `Scenario 3 — journal append should succeed with 35 paths; got ${JSON.stringify(appended)}`,
  );
  const appendedTrunc = appended["truncated"];
  assert(
    Array.isArray(appendedTrunc) && appendedTrunc.includes("files_touched"),
    `Scenario 3 — response should carry truncated:["files_touched"]; got ${JSON.stringify(appended)}`,
  );
  const dropped = appended["dropped"] as Record<string, unknown> | undefined;
  assert(
    dropped !== undefined && Array.isArray(dropped["files_touched"]),
    `Scenario 3 — response should carry dropped.files_touched array; got ${JSON.stringify(appended)}`,
  );
  const droppedFiles = dropped["files_touched"] as string[];
  assert(
    droppedFiles.length === 15,
    `Scenario 3 — dropped.files_touched should hold 15 paths; got ${droppedFiles.length}`,
  );
  assert(
    droppedFiles[0] === paths35[20] && droppedFiles[14] === paths35[34],
    `Scenario 3 — dropped tail should be the trailing slice; got ${JSON.stringify(droppedFiles)}`,
  );
  const journalPath = join(activeDir, "journal.jsonl");
  const journalLine = readFileSync(journalPath, "utf8").trim();
  const parsed = JSON.parse(journalLine) as { files_touched?: string[] };
  assert(
    Array.isArray(parsed.files_touched) && parsed.files_touched.length === 20,
    `Scenario 3 — journal entry should hold exactly 20 files_touched; got ${parsed.files_touched?.length}`,
  );
  assert(
    parsed.files_touched[0] === paths35[0] && parsed.files_touched[19] === paths35[19],
    `Scenario 3 — journal entry should keep the leading 20; got ${JSON.stringify(parsed.files_touched)}`,
  );
  console.log("  ✓ Scenario 3 — files_touched=35 keeps first 20 + drops trailing 15");

  // Scenario 4 — files_touched=12 stays whole.
  const paths12 = Array.from({ length: 12 }, (_, i) => `src/mod${i + 1}.ts`);
  const appendedSmall = await call(journalTool, ctx, {
    task_id: taskId,
    summary: "Phase 7 soft-truncate smoke — files_touched=12 (under cap).",
    files_touched: paths12,
  });
  assert(
    appendedSmall["ok"] === true,
    `Scenario 4 — journal append should succeed; got ${JSON.stringify(appendedSmall)}`,
  );
  assert(
    appendedSmall["truncated"] === undefined,
    `Scenario 4 — under-cap response should not carry truncated; got ${JSON.stringify(appendedSmall)}`,
  );
  assert(
    appendedSmall["dropped"] === undefined,
    `Scenario 4 — under-cap response should not carry dropped; got ${JSON.stringify(appendedSmall)}`,
  );
  const journalLines = readFileSync(journalPath, "utf8").trim().split("\n");
  const lastParsed = JSON.parse(journalLines[journalLines.length - 1]!) as {
    files_touched?: string[];
  };
  assert(
    Array.isArray(lastParsed.files_touched) && lastParsed.files_touched.length === 12,
    `Scenario 4 — journal entry should hold all 12 paths; got ${lastParsed.files_touched?.length}`,
  );
  console.log("  ✓ Scenario 4 — under-cap files_touched stays whole");

  cleanup();
  console.log("smoke-bug-mine-0.13.10 — pass");
}

runSmoke().catch((err: unknown) => {
  console.error("smoke-bug-mine-0.13.10 — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
