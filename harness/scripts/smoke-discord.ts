#!/usr/bin/env tsx
/**
 * smoke-discord — Phase 5 acceptance sensor.
 *
 * Per RESUME_PROMPT.md §10 deliverable 6: integration test creates a task
 * channel via /task and verifies category placement. Real Discord requires
 * creds; smoke against the STUB adapter exercises the same FrontendAdapter
 * contract without Discord I/O. Live-bot wiring is gated on the operator
 * providing DISCORD_BOT_TOKEN — out of band here.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFrontendAdapter } from "../src/frontend/index.js";
import { parseOwnerIds, isOwner } from "../src/frontend/discord/acl.js";
import { classifyFreeText } from "../src/frontend/discord/classifier.js";
import { slugifyForChannel } from "../src/frontend/discord/channels.js";
import {
  SLASH_COMMAND_NAMES,
  buildSlashCommands,
} from "../src/frontend/discord/slash.js";

let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-discord FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function readInbox(repoRoot: string): { name: string; row: Record<string, unknown> }[] {
  const dir = join(repoRoot, ".harness", "inbox");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      row: JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>,
    }));
}

async function main(): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-smoke-discord-"));
  cleanupPaths.push(repoRoot);

  header("Step 1: pure helpers");
  if (SLASH_COMMAND_NAMES.length !== 13)
    fail(`expected 13 slash commands, got ${SLASH_COMMAND_NAMES.length}`);
  const builders = buildSlashCommands();
  if (builders.length !== 13) fail(`builders mismatch: ${builders.length}`);
  const taskBuilder = builders.find((b) => b.name === "task");
  if (!taskBuilder) fail("/task builder not found");
  const taskJson = taskBuilder.toJSON();
  const bodyOption = taskJson.options?.[0];
  if (!bodyOption || bodyOption.name !== "body") fail("/task missing body option");

  const owners = parseOwnerIds("123, 456,789 ");
  if (!isOwner(owners, "123") || !isOwner(owners, "456") || !isOwner(owners, "789")) {
    fail("parseOwnerIds did not split correctly");
  }
  if (isOwner(owners, "999")) fail("isOwner allowed non-listed user");
  if (parseOwnerIds(undefined).size !== 0) fail("undefined env should yield empty allowlist");

  if (slugifyForChannel("Add unique partial index!") !== "add-unique-partial-index") {
    fail("slugifyForChannel did not normalize");
  }
  if (slugifyForChannel("") !== "task") fail("empty body should default to 'task'");

  const codeIntent = classifyFreeText("fix the integration thing");
  if (codeIntent.intent !== "code_task") fail(`code_task classify: ${codeIntent.intent}`);
  const reviewIntent = classifyFreeText("review the integrations module for cross-tenant leaks");
  if (reviewIntent.intent !== "review") fail(`review classify: ${reviewIntent.intent}`);
  const haltIntent = classifyFreeText("halt");
  if (haltIntent.intent !== "halt") fail(`halt classify: ${haltIntent.intent}`);
  const directionIntent = classifyFreeText("scrap that, FK denorm only");
  if (directionIntent.intent !== "direction")
    fail(`direction classify: ${directionIntent.intent}`);
  const unknownIntent = classifyFreeText("zzz nonsense");
  if (unknownIntent.intent !== "unknown") fail(`unknown classify: ${unknownIntent.intent}`);

  header("Step 2: stub adapter — start, contract surface");
  const adapter = new StubFrontendAdapter({
    repoRoot,
    approvalResponse: { bundleId: "B1", decision: "approve" },
    dialogResponse: { bundleId: "B2", choiceId: "a" },
  });

  let taskCount = 0;
  let voiceCount = 0;
  let slashCount = 0;
  let freeTextCount = 0;
  let interactionCount = 0;
  adapter.onTask(() => {
    taskCount += 1;
  });
  adapter.onVoice(() => {
    voiceCount += 1;
  });
  adapter.onSlash(() => {
    slashCount += 1;
  });
  adapter.onFreeText(() => {
    freeTextCount += 1;
  });
  adapter.onInteraction(() => {
    interactionCount += 1;
  });

  await adapter.start();

  header("Step 3: ingest events drop normalized inbox rows");
  await adapter.pushTask({
    source: "stub",
    intent: "code_task",
    rawText: "add unique partial index",
    authorId: "123",
    receivedAt: new Date().toISOString(),
    channelId: "C1",
    messageId: "M1",
  });
  await adapter.pushVoice({
    source: "stub",
    attachmentUrl: "https://cdn/example.ogg",
    authorId: "123",
    channelId: "C1",
    messageId: "M2",
    receivedAt: new Date().toISOString(),
    mime: "audio/ogg",
  });
  await adapter.pushSlash({
    source: "stub",
    command: "status",
    options: {},
    authorId: "123",
    receivedAt: new Date().toISOString(),
    channelId: "C2",
    messageId: "M3",
  });
  await adapter.pushFreeText({
    source: "stub",
    intent: "review",
    rawText: "review the integrations module",
    authorId: "123",
    receivedAt: new Date().toISOString(),
    channelId: "C2",
    messageId: "M4",
  });
  await adapter.pushInteraction({
    source: "stub",
    bundleId: "B-FAKE",
    choiceId: "approve",
    authorId: "123",
    receivedAt: new Date().toISOString(),
    channelId: "C2",
    messageId: "M5",
  });

  if (taskCount !== 1) fail(`task handler count: ${taskCount}`);
  if (voiceCount !== 1) fail(`voice handler count: ${voiceCount}`);
  if (slashCount !== 1) fail(`slash handler count: ${slashCount}`);
  if (freeTextCount !== 1) fail(`free_text handler count: ${freeTextCount}`);
  if (interactionCount !== 1) fail(`interaction handler count: ${interactionCount}`);

  const rows = readInbox(repoRoot);
  if (rows.length !== 5) fail(`expected 5 inbox rows, got ${rows.length}`);
  const kinds = rows.map((r) => r.row["kind"]);
  for (const k of ["task", "voice", "slash", "free_text", "interaction"]) {
    if (!kinds.includes(k)) fail(`missing inbox kind: ${k}`);
  }
  for (const { name, row } of rows) {
    if (row["source"] !== "stub") fail(`row ${name} missing source`);
    if (typeof row["received_at"] !== "string") fail(`row ${name} missing received_at`);
  }

  header("Step 4: outbound surface — postTaskUpdate, requestApproval, requestDialog, notify");
  await adapter.postTaskUpdate({
    taskId: "TSK-1",
    runId: "run-1",
    status: "running",
    body: "phase: planning",
    channelId: "C1",
  });
  if (adapter.recorded.taskUpdates.length !== 1) fail("postTaskUpdate not recorded");

  const approval = await adapter.requestApproval({
    bundleId: "B1",
    runId: "run-1",
    goal: "add unique partial index",
    diffSummary: "3 files +17/-0",
    acceptance: [{ id: "AC1", status: "pass" }],
    channelId: "C1",
  });
  if (approval.decision !== "approve") fail(`approval: ${approval.decision}`);

  const dialog = await adapter.requestDialog({
    bundleId: "B2",
    prompt: "Pick one",
    choices: [
      { id: "a", label: "first" },
      { id: "b", label: "second" },
      { id: "e_other", label: "Other" },
    ],
    channelId: "C1",
  });
  if (dialog.choiceId !== "a") fail(`dialog: ${dialog.choiceId}`);

  await adapter.notify("warn", "test warning");
  if (adapter.recorded.notifications.length !== 1) fail("notify not recorded");
  if (adapter.recorded.notifications[0]?.level !== "warn") fail("notify level mismatch");

  header("Step 5: stop + cleanup");
  await adapter.stop();
  // double-stop should be idempotent (no throw)
  await adapter.stop();

  // Subsequent pushTask should reject — adapter not started
  let threw = false;
  try {
    await adapter.pushTask({
      source: "stub",
      intent: "code_task",
      rawText: "post-stop",
      authorId: "123",
      receivedAt: new Date().toISOString(),
    });
  } catch {
    threw = true;
  }
  if (!threw) fail("pushTask after stop should throw");

  cleanup();
  console.log("\nsmoke-discord: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
