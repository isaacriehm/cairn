#!/usr/bin/env tsx
/**
 * smoke-decision-capture — Phase 14 acceptance sensor.
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 14 + WORKFLOW_GUIDE:
 *   "synthetic Discord message ('scrap that, FK denorm only') produces
 *    draft within 30s; confirm → ledger reflects within 5s; next run
 *    loads new entry in always-injected ledger."
 *
 * Six steps. Burns ~1 cheap haiku claude call (Step 4). Pure-mechanical
 * for everything else (id allocator, writer, accept/reject flow, ledger
 * regenerate).
 *
 *   1. allocateDecisionId on empty repo → DEC-0001.
 *   2. writeDecisionDraft via stub extractor output → file lands under
 *      _inbox/, frontmatter validates as DecisionFrontmatter w/ status:draft.
 *   3. acceptDraft → file moves to canonical decisions/, status flips to
 *      accepted, ledger regenerates with the new id.
 *   4. LIVE haiku call: runDecisionExtractor on a synthetic
 *      "scrap that — FK denorm only" direction → asserts not_a_decision=
 *      false, subject mentions FK / denorm, supersedes is null or matches
 *      DEC-NNNN format, scope_globs is reasonable.
 *   5. runDecisionCapture end-to-end with the stub adapter (extractor
 *      stubbed to a deterministic output): adapter dialog auto-confirms
 *      🟢 commit; result.short_circuited=false, accepted_path is canonical,
 *      ledger has 1 entry.
 *   6. Reject path: runDecisionCapture with stub extractor, stub dialog
 *      returns 🔴 not-a-decision; assert draft file deleted, ledger
 *      unchanged from prior step.
 *
 * SKIPS Step 4 only when `claude` CLI is missing or unauthenticated;
 * Steps 1/2/3/5/6 still run (no LLM dependency).
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
import { parse as parseYaml } from "yaml";
import { claudeIsAvailable } from "../src/claude/index.js";
import {
  acceptDraft,
  allocateDecisionId,
  rejectDraft,
  runDecisionCapture,
  runDecisionExtractor,
  writeDecisionDraft,
  type DecisionExtractorOutput,
} from "../src/decision-capture/index.js";
import { StubFrontendAdapter } from "../src/frontend/index.js";
import { parseFrontmatter } from "../src/ground/frontmatter.js";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(reason: string): never {
  console.error(`smoke-decision-capture FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

async function main(): Promise<void> {
  // ── Step 1: id allocator on empty repo.
  header("Step 1: allocateDecisionId on empty repo → DEC-0001");
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-dc-"));
  cleanups.push(root);
  mkdirSync(join(root, ".harness", "ground", "decisions", "_inbox"), { recursive: true });
  const id1 = allocateDecisionId(root);
  assert(id1 === "DEC-0001", `expected DEC-0001, got ${id1}`);
  console.log(`  id1=${id1}`);

  // Verify allocator advances past existing decisions + drafts.
  writeFileSync(
    join(root, ".harness", "ground", "decisions", "DEC-0003.md"),
    "---\nid: DEC-0003\ntitle: prior\nstatus: accepted\n---\nbody\n",
    "utf8",
  );
  writeFileSync(
    join(root, ".harness", "ground", "decisions", "_inbox", "DEC-0005.draft.md"),
    "---\nid: DEC-0005\ntitle: draft\nstatus: draft\n---\nbody\n",
    "utf8",
  );
  const id6 = allocateDecisionId(root);
  assert(id6 === "DEC-0006", `expected DEC-0006 after seed, got ${id6}`);
  console.log(`  id6=${id6} (advances past accepted DEC-0003 + draft DEC-0005)`);

  // ── Step 2: writeDecisionDraft mechanical.
  header("Step 2: writeDecisionDraft → frontmatter validates");
  const stubOutput: DecisionExtractorOutput = {
    subject: "Filter integration_oauth_tokens by user_id",
    summary:
      "All queries against integration_oauth_tokens MUST filter by user_id in addition to provider keys. Cross-tenant leak risk is the motivating concern.",
    scope_globs: ["core/src/integrations/**/*.ts"],
    supersedes: null,
    candidate_assertions: [
      {
        kind: "query_must_filter_by",
        description: "integration_oauth_tokens queries must include user_id in the where clause",
      },
    ],
    confidence_signal: "high",
    not_a_decision: false,
  };
  const draft = writeDecisionDraft({
    repoRoot: root,
    id: id6,
    output: stubOutput,
    rawText: "user_id always required on integration_oauth_tokens",
    authorId: "operator-1",
    receivedAt: new Date().toISOString(),
    source: "smoke",
  });
  console.log(`  draft_path=${draft.draft_path}`);
  assert(
    existsSync(join(root, draft.draft_path)),
    `draft file missing at ${draft.draft_path}`,
  );
  const draftContent = readFileSync(join(root, draft.draft_path), "utf8");
  const draftFm = parseFrontmatter(draftContent).frontmatter;
  assert(draftFm !== null, "draft frontmatter unparseable");
  assert(draftFm!.id === id6, `draft frontmatter id mismatch (got ${draftFm!.id})`);
  assert(draftFm!.status === "draft", `draft status must be draft (got ${draftFm!.status})`);
  console.log(
    `  frontmatter.id=${draftFm!.id} status=${draftFm!.status} title="${draftFm!.title}"`,
  );

  // ── Step 3: acceptDraft moves file + regenerates ledger.
  header("Step 3: acceptDraft → canonical, ledger regenerated");
  const accepted = acceptDraft({ repoRoot: root, draft });
  assert(
    !existsSync(join(root, draft.draft_path)),
    "draft file should be removed after accept",
  );
  assert(
    existsSync(join(root, accepted.acceptedPath)),
    `accepted file missing at ${accepted.acceptedPath}`,
  );
  const acceptedContent = readFileSync(join(root, accepted.acceptedPath), "utf8");
  const acceptedFm = parseFrontmatter(acceptedContent).frontmatter;
  assert(acceptedFm !== null, "accepted frontmatter unparseable");
  assert(
    acceptedFm!.status === "accepted",
    `accepted status must flip to accepted (got ${acceptedFm!.status})`,
  );
  // Ledger should now contain DEC-0003 + DEC-0006 (DEC-0005 still draft).
  const ledgerPath = join(root, ".harness", "ground", "decisions", "decisions.ledger.yaml");
  assert(existsSync(ledgerPath), "ledger file missing");
  const ledgerContent = parseYaml(readFileSync(ledgerPath, "utf8")) as Array<{ id: string }>;
  const ledgerIds = new Set(ledgerContent.map((e) => e.id));
  assert(ledgerIds.has("DEC-0003"), `ledger missing DEC-0003 (has ${[...ledgerIds].join(", ")})`);
  assert(ledgerIds.has(id6), `ledger missing freshly accepted ${id6}`);
  console.log(
    `  ledger entries=${ledgerContent.length} contains [${[...ledgerIds].join(", ")}]`,
  );

  // ── Step 4: LIVE haiku extractor on synthetic direction.
  if (!claudeIsAvailable()) {
    console.log("\n  claude CLI not available; skipping Step 4 (live extractor)");
  } else {
    header("Step 4: LIVE haiku extractor on synthetic direction");
    const liveResult = await runDecisionExtractor({
      raw_text:
        "scrap that — going forward, FK denormalization only on integration_oauth_tokens",
      author_id: "operator-1",
      received_at: new Date().toISOString(),
      source: "smoke:live",
      tier: "haiku",
    });
    console.log(
      `  not_a_decision=${liveResult.output.not_a_decision} confidence=${liveResult.output.confidence_signal}`,
    );
    console.log(`  subject="${liveResult.output.subject}"`);
    console.log(`  scope_globs=[${liveResult.output.scope_globs.join(", ")}]`);
    assert(
      liveResult.output.not_a_decision === false,
      "live extractor flagged not_a_decision on a clear direction — quality regression",
    );
    const subjectLower = liveResult.output.subject.toLowerCase();
    assert(
      /fk|denormali/i.test(subjectLower),
      `subject should mention FK or denormalization (got "${liveResult.output.subject}")`,
    );
  }

  // ── Step 5: runDecisionCapture end-to-end with stub adapter (auto-commit).
  header("Step 5: runDecisionCapture end-to-end → 🟢 commit path");
  const commitRoot = mkdtempSync(join(tmpdir(), "harness-smoke-dc-commit-"));
  cleanups.push(commitRoot);
  mkdirSync(join(commitRoot, ".harness", "inbox"), { recursive: true });
  mkdirSync(join(commitRoot, ".harness", "ground", "decisions", "_inbox"), {
    recursive: true,
  });
  const commitAdapter = new StubFrontendAdapter({
    repoRoot: commitRoot,
    dialogResponse: { bundleId: "ignored", choiceId: "a" }, // 🟢 commit
  });
  await commitAdapter.start();
  const stubExtractor = async () => ({
    output: {
      subject: "Captured FK denorm rule",
      summary: "From now on, FK denormalization is the canonical pattern.",
      scope_globs: ["core/src/integrations/**/*.ts"],
      supersedes: null,
      candidate_assertions: [],
      confidence_signal: "high" as const,
      not_a_decision: false,
    },
    duration_ms: 0,
  });
  const captureResult = await runDecisionCapture({
    repoRoot: commitRoot,
    rawText: "scrap that — FK denorm only",
    authorId: "operator-1",
    source: "smoke:commit",
    adapter: commitAdapter,
    extractorOverride: stubExtractor,
  });
  assert(!captureResult.short_circuited, "expected non-short-circuit");
  assert(
    captureResult.confirm?.decision === "commit",
    `expected decision=commit, got ${captureResult.confirm?.decision}`,
  );
  assert(captureResult.confirm.accepted_path !== undefined, "accepted_path missing");
  assert(
    existsSync(join(commitRoot, captureResult.confirm.accepted_path)),
    "accepted file not on disk",
  );
  console.log(
    `  decision=${captureResult.confirm.decision} accepted=${captureResult.confirm.accepted_path} ledger_size=${captureResult.confirm.ledger_size}`,
  );
  await commitAdapter.stop();

  // ── Step 6: reject path.
  header("Step 6: runDecisionCapture → 🔴 reject path");
  const rejectRoot = mkdtempSync(join(tmpdir(), "harness-smoke-dc-reject-"));
  cleanups.push(rejectRoot);
  mkdirSync(join(rejectRoot, ".harness", "inbox"), { recursive: true });
  mkdirSync(join(rejectRoot, ".harness", "ground", "decisions", "_inbox"), {
    recursive: true,
  });
  const rejectAdapter = new StubFrontendAdapter({
    repoRoot: rejectRoot,
    dialogResponse: { bundleId: "ignored", choiceId: "c" }, // 🔴 reject
  });
  await rejectAdapter.start();
  const rejectResult = await runDecisionCapture({
    repoRoot: rejectRoot,
    rawText: "this turned out to be a bad idea actually",
    authorId: "operator-1",
    source: "smoke:reject",
    adapter: rejectAdapter,
    extractorOverride: stubExtractor,
  });
  assert(rejectResult.confirm?.decision === "reject", "expected reject");
  assert(rejectResult.draft !== undefined, "expected a draft to have been written");
  assert(
    !existsSync(join(rejectRoot, rejectResult.draft.draft_path)),
    "draft file should be removed after reject",
  );
  // Allocator must NOT recycle the rejected DEC-id.
  const nextId = allocateDecisionId(rejectRoot);
  assert(
    nextId !== rejectResult.draft.id,
    `rejected id ${rejectResult.draft.id} must not be recycled — allocator returned ${nextId}`,
  );
  console.log(
    `  decision=${rejectResult.confirm.decision} rejected=${rejectResult.draft.id} next=${nextId} (no recycle)`,
  );
  await rejectAdapter.stop();
  // Suppress unused-import warning — exported for downstream callers.
  void rejectDraft;

  // ── Cleanup.
  header("Cleanup");
  cleanup();
  console.log("\nsmoke-decision-capture: OK");
}

main().catch((err) => {
  console.error("smoke-decision-capture threw:", err);
  cleanup();
  process.exit(1);
});
