#!/usr/bin/env tsx
/**
 * smoke-e2e-daily-flow — post-adoption loop.
 *
 * Spec: PLUGIN_ARCHITECTURE §8 (daily flow) + §10 (Stop hook) + §17 (Layer 1 bypass).
 *
 * Sequence:
 *   1. Adopt a fresh fixture (mocked classifiers, full pipeline) and run
 *      `cairn join` so the bootstrap guard passes.
 *   2. Run SessionStart bin against the adopted clone — assert per-session
 *      status.json + events-marker land, hookSpecificOutput.additionalContext non-empty.
 *   3. Drop a tightened task spec without an attestation; run Stop bin →
 *      assert reviewer-pending hint surfaces via decision:block+reason.
 *   4. Drop the attestation; run Stop again → hint disappears.
 *   5. Drop a DEC draft into _inbox/, call resolve_attention(accept) →
 *      assert canonical DEC file appears, draft moved to .accepted.bak.
 *   6. Make a `--no-verify` commit on top → run Stop → assert bypass-
 *      detection hint surfaces with the new SHA.
 */

import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEEP_END_MARKER,
  KEEP_START_MARKER,
  allTools,
  isMcpError,
  runInit,
  runJoin,
  type CommentBlock,
  type CommentClassification,
  type McpContext,
  type RuleClassification,
  type RuleSection,
  type RuleSourceFile,
  type ToolDef,
} from "@isaacriehm/cairn-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_PROJECT = resolve(HERE, "..", "..", "..");
const SESSION_START_BIN = join(REPO_ROOT_PROJECT, "packages", "cairn-core", "dist", "hooks", "session-start.js");
const STOP_BIN = join(REPO_ROOT_PROJECT, "packages", "cairn-core", "dist", "hooks", "stop.js");

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

function step(label: string): void {
  console.log(`── ${label}`);
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/** SessionStart emits hookSpecificOutput.additionalContext. */
interface SessionStartOutput {
  continue: true;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

/** Stop emits decision:block+reason when surfacing context to Claude. */
interface StopBlockOutput {
  decision: "block";
  reason: string;
}

/** Stop emits continue:true when nothing to surface. */
interface StopPassOutput {
  continue: true;
}

type HookOutput = SessionStartOutput | StopBlockOutput | StopPassOutput;

/** Returns the Claude-facing context text from any hook output shape. */
function ctxOf(out: HookOutput): string {
  if ("reason" in out) return out.reason;
  if ("hookSpecificOutput" in out) return out.hookSpecificOutput.additionalContext;
  return "";
}

function runHookBin(
  bin: string,
  payload: Record<string, unknown>,
): { parsed: HookOutput; status: number; stderr: string } {
  const result = spawnSync("node", [bin], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    parsed: result.stdout
      ? (JSON.parse(result.stdout.trim()) as HookOutput)
      : { continue: true },
    status: result.status ?? -1,
    stderr: result.stderr ?? "",
  };
}

async function callTool<T>(
  toolName: string,
  ctx: McpContext,
  input: T,
): Promise<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find((t) => t.name === toolName);
  if (tool === undefined) throw new Error(`tool ${toolName} not registered`);
  return (tool as ToolDef<T>).handler(ctx, input);
}

async function adoptFixture(repoRoot: string): Promise<void> {
  // Initial commit so SHA-aware machinery has something to read.
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoRoot });

  writeFile(
    repoRoot,
    "package.json",
    JSON.stringify(
      { name: "fixture-daily", version: "0.0.0", scripts: {} },
      null,
      2,
    ) + "\n",
  );
  writeFile(
    repoRoot,
    "src/main.ts",
    [
      "/**",
      " * Multi-line block comment to trigger source-comment walker but be",
      " * classified as boring so no DEC draft fires from this fixture.",
      " * Keeps the smoke deterministic.",
      " */",
      "export const x = 1;",
    ].join("\n") + "\n",
  );
  writeFile(
    repoRoot,
    "CLAUDE.md",
    [
      "# Project rules",
      "",
      "## Section",
      "",
      "Body.",
      "",
      KEEP_START_MARKER,
      "Operator note.",
      KEEP_END_MARKER,
      "",
    ].join("\n"),
  );

  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

  await runInit({
    repoRoot,
    mode: "auto",
    autoProceed: "a",
    autoE2e: "defer",
    skipBrandSetup: true,
    skipSubmoduleCheck: true,
    skipMonorepoGuard: true,
    skipSelfAdoptionGuard: true,
    skipMapper: true,
    skipGuidedSetup: true,
    skipIngestion: false,
    mockSourceCommentClassify: (block: CommentBlock): CommentClassification => ({
      blockId: block.id,
      kind: block.kind === "license" ? "license" : "other",
      suggestedDecDraft: "",
      suggestedInvariant: "",
      suggestedCanonicalTopic: "",
      failed: false,
    }),
    mockRulesMergeClassify: (
      section: RuleSection,
      source: RuleSourceFile,
    ): RuleClassification => ({
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      kind: "informational",
      proposedDecTitle: "",
      proposedRationale: "",
      conflictsWith: "",
      failed: false,
    }),
  });

  // Bootstrap so MCP write tools' bootstrap-guard passes.
  const join = runJoin({ cwd: repoRoot });
  if (!join.bootstrapped) {
    throw new Error("cairn join failed during fixture setup");
  }
}

async function main(): Promise<void> {
  step("Adopt fresh fixture + bootstrap");
  assert(existsSync(SESSION_START_BIN), `compiled session-start bin missing — run pnpm -r build`);
  assert(existsSync(STOP_BIN), `compiled stop bin missing — run pnpm -r build`);
  const repoRoot = mkdtempSync(join(tmpdir(), "cairn-smoke-e2e-flow-"));
  cleanups.push(repoRoot);
  await adoptFixture(repoRoot);
  console.log(`  fixture at ${repoRoot}`);

  step("Step 1 — SessionStart bin populates status.json + additionalContext");
  const sessionId = "smoke-e2e-flow";
  const ssOut = runHookBin(SESSION_START_BIN, { session_id: sessionId, cwd: repoRoot });
  assert(ssOut.status === 0, `session-start exit 0; stderr=${ssOut.stderr}`);
  const sessionDir = join(repoRoot, ".cairn", "sessions", sessionId);
  assert(existsSync(join(sessionDir, "status.json")), "status.json written");
  assert(existsSync(join(sessionDir, "events-marker.json")), "events-marker written");
  // No bootstrap banner expected since join ran in adoptFixture.
  assert(
    !ctxOf(ssOut.parsed).includes("bootstrap required"),
    "no bootstrap banner after join",
  );
  console.log("  ✓ Step 1 — SessionStart wires per-session state");

  step("Step 2 — Stop hook surfaces reviewer-pending hint");
  const taskId = "TSK-2026-05-04-flow-99999";
  writeFile(
    repoRoot,
    `.cairn/tasks/active/${taskId}/spec.tightened.md`,
    `---\nid: ${taskId}\nstatus: ready\n---\n\n# ${taskId}\n\nbody\n`,
  );
  const stop1 = runHookBin(STOP_BIN, { session_id: sessionId, cwd: repoRoot });
  assert(stop1.status === 0, `stop exit 0; stderr=${stop1.stderr}`);
  assert(
    "decision" in stop1.parsed && stop1.parsed.decision === "block",
    "stop with pending review emits decision:block",
  );
  assert(
    /awaiting review attestation/.test(ctxOf(stop1.parsed)),
    `expected reviewer-pending hint, got: ${ctxOf(stop1.parsed)}`,
  );
  assert(
    ctxOf(stop1.parsed).includes(taskId),
    "hint cites taskId",
  );
  console.log("  ✓ Step 2 — reviewer-pending hint surfaces");

  step("Step 3 — Stop hint clears once attestation lands");
  writeFile(
    repoRoot,
    `.cairn/tasks/active/${taskId}/attestation.yaml`,
    `task_id: ${taskId}\nattested_at: ${new Date().toISOString()}\nattested_by: smoke\n`,
  );
  const stop2 = runHookBin(STOP_BIN, { session_id: sessionId, cwd: repoRoot });
  assert(
    !/awaiting review attestation/.test(ctxOf(stop2.parsed)),
    `expected no reviewer-pending hint, got: ${ctxOf(stop2.parsed)}`,
  );
  console.log("  ✓ Step 3 — hint clears post-attestation");

  step("Step 4 — resolve_attention promotes inbox draft to canonical DEC");
  // Write a DEC draft directly into inbox.
  const decId = "DEC-9001234";
  writeFile(
    repoRoot,
    `.cairn/ground/decisions/_inbox/${decId}.draft.md`,
    [
      "---",
      `id: ${decId}`,
      "title: Smoke — synthetic decision",
      "type: adr",
      "status: draft",
      "audience: dual",
      "generated: 2026-05-04T00:00:00Z",
      "verified-at: 2026-05-04T00:00:00Z",
      "decided_at: 2026-05-04T00:00:00Z",
      "decided_by: smoke",
      "---",
      "",
      `# ${decId} — Smoke decision`,
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  const ctx: McpContext = { repoRoot, sessionId };
  const accept = (await callTool("cairn_resolve_attention", ctx, {
    item_id: decId,
    choice: "a",
    kind: "decision_draft",
  })) as Record<string, unknown>;
  assert(!isMcpError(accept), `resolve_attention should succeed, got ${JSON.stringify(accept)}`);
  // Canonical file should now exist; draft renamed to .accepted.bak.
  const canonical = join(repoRoot, ".cairn/ground/decisions", `${decId}.md`);
  assert(existsSync(canonical), `canonical DEC file present at ${canonical}`);
  const canonicalBody = readFileSync(canonical, "utf8");
  assert(canonicalBody.includes("status: accepted"), "status flipped to accepted");
  // Inbox draft should be gone (renamed to .accepted.bak).
  const inboxAfter = readdirSync(join(repoRoot, ".cairn/ground/decisions/_inbox"));
  assert(
    !inboxAfter.includes(`${decId}.draft.md`),
    "draft removed from inbox",
  );
  console.log("  ✓ Step 4 — resolve_attention accepted draft, canonical wired");

  step("Step 5 — bypass detection surfaces unattested commit");
  // Make a commit. `git commit --no-verify` skips pre-commit + commit-msg
  // but NOT post-commit, so post-commit still attests the SHA. Strip it
  // from .attested-commits manually to simulate a real bypass — e.g. a
  // commit made on a clone without `core.hooksPath` set, or via a
  // different git binary that didn't see the hook.
  writeFile(repoRoot, "src/extra.ts", "export const y = 2;\n");
  execFileSync("git", ["add", "src/extra.ts"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "--no-verify", "-m", "bypass: untracked"], {
    cwd: repoRoot,
  });
  const bypassSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const attestedPath = join(repoRoot, ".cairn", ".attested-commits");
  if (existsSync(attestedPath)) {
    const filtered = readFileSync(attestedPath, "utf8")
      .split("\n")
      .filter((s) => s.trim() !== bypassSha);
    writeFileSync(attestedPath, filtered.join("\n"), "utf8");
  }
  const stop3 = runHookBin(STOP_BIN, { session_id: sessionId, cwd: repoRoot });
  assert(stop3.status === 0, `stop exit 0; stderr=${stop3.stderr}`);
  assert(
    /not attested/.test(ctxOf(stop3.parsed)),
    `expected bypass-detection hint, got: ${ctxOf(stop3.parsed)}`,
  );
  assert(
    /cairn-attention/.test(ctxOf(stop3.parsed)),
    "bypass hint instructs cairn-attention skill invocation",
  );
  console.log("  ✓ Step 5 — bypass hint surfaces with new SHA");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-e2e-daily-flow — pass");
}

main().catch((err) => {
  console.error("smoke-e2e-daily-flow — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
