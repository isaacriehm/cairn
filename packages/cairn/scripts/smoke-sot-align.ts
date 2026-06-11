#!/usr/bin/env tsx
/**
 * smoke-sot-align — Layer A PostToolUse alignment hook (plan §4.1).
 *
 * Each step mounts a fresh fixture, simulates the post-Write file
 * state, drives `alignFile` directly with mock judges where Haiku
 * would otherwise fire, and asserts the resulting on-disk state.
 *
 *   Step 1 — Tier 1 deterministic auto-cite (verbatim duplicate of
 *            an accepted DEC). No mock judge needed; no Haiku call.
 *   Step 2 — Tier 2 Pass 1 dedup judge `same` → cite. Mock judge.
 *   Step 3 — Tier 3 Pass 1 creation judge `decision` → fresh ledger
 *            DEC, source strip-replaced. Mock judge.
 *   Step 4 — Tier 3 creation judge `descriptive` → no-op, source
 *            untouched. Mock judge.
 *   Step 5 — Per-Write Haiku call cap → excess deferred to staleness.
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
import { execFileSync } from "node:child_process";
import {
  alignFile,
  bodyContentHash,
  emptySotBindings,
  emptySotCache,
  bindDec,
  setSotCacheEntry,
  tokenize,
  writeSotBindings,
  writeSotCache,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-sotalign-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commitAll(repoRoot: string): void {
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

function seedAcceptedDec(
  repoRoot: string,
  id: string,
  body: string,
  sotPath = "ledger",
): void {
  const fm = [
    "---",
    `id: ${id}`,
    "title: Smoke seeded",
    "type: adr",
    "status: accepted",
    "audience: dual",
    "generated: 2026-01-01T00:00:00Z",
    "verified-at: 2026-01-01T00:00:00Z",
    "decided_at: 2026-01-01T00:00:00Z",
    "decided_by: smoke",
    `sot_kind: ${sotPath === "ledger" ? "ledger" : "path"}`,
    `sot_path: ${sotPath}`,
    `sot_content_hash: ${bodyContentHash(body)}`,
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFile(repoRoot, `.cairn/ground/decisions/${id}.md`, fm);

  let bindings = emptySotBindings();
  bindings = bindDec(bindings, id, sotPath);
  writeSotBindings(repoRoot, bindings);

  let cache = emptySotCache();
  cache = setSotCacheEntry(cache, id, {
    dec_id: id,
    sot_path: sotPath,
    body_hash: bodyContentHash(body),
    tokens: Array.from(tokenize(body, { codeAware: true })),
    shingles: [],
    mtime_ms: Date.now(),
  });
  writeSotCache(repoRoot, cache);
}

async function main(): Promise<void> {
  console.log("smoke-sot-align — start");

  // ── Step 1 — Tier 1 verbatim duplicate auto-cite ─────────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "We pin Postgres at version 15 because the legacy ETL job depends on its",
      "specific replication slot semantics. The team has tried 16 twice and rolled",
      "back both times. Revisit when the ETL job is rewritten.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-1234567", seedBody);

    // Source file has a JSDoc with the verbatim seed body.
    const source = [
      "/**",
      " * We pin Postgres at version 15 because the legacy ETL job depends on its",
      " * specific replication slot semantics. The team has tried 16 twice and rolled",
      " * back both times. Revisit when the ETL job is rewritten.",
      " */",
      "export function db() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/db.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/db.ts",
      sessionId: null,
    });
    assert(result.tier1Aligned === 1, `Step 1: tier1Aligned=1, got ${result.tier1Aligned}`);
    assert(result.haikuCalls === 0, `Step 1: no Haiku calls (deterministic), got ${result.haikuCalls}`);
    const after = readFileSync(join(repoRoot, "src/db.ts"), "utf8");
    assert(after.includes("// §DEC-1234567"), "Step 1: source cites seeded DEC");
    assert(!after.includes("legacy ETL"), "Step 1: original prose stripped");
    console.log("  ✓ Step 1 — Tier 1 deterministic auto-cite, no Haiku");
  }

  // ── Step 2 — Tier 2 Pass 1 mock dedup `same` → cite ──────────────
  {
    const repoRoot = mkRepoRoot();
    const seedBody = [
      "Sign JWTs with HS512 not RS256 because deployment topology lacks key rotation",
      "infrastructure today. Revisit when KMS arrives.",
    ].join("\n");
    seedAcceptedDec(repoRoot, "DEC-2222222", seedBody);

    // Source has a similar block — same idea, different wording so Jaccard
    // lands between 0.3 and 0.85 (Tier 2 territory).
    const source = [
      "/**",
      " * We sign tokens via HS512 instead of RS256 today. Topology has no key",
      " * rotation surface; KMS arrival reopens this. JWT auth path uses HS512.",
      " */",
      "export function sign() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/auth.ts", source);
    commitAll(repoRoot);

    let dedupCalls = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "src/auth.ts",
      sessionId: null,
      mockDedupJudgePass1: async ({ candidate }) => {
        dedupCalls += 1;
        return candidate.id === "DEC-2222222" ? "same" : "different";
      },
      mockCreationJudgePass1: async () => "descriptive",
    });
    assert(result.tier2Aligned === 1, `Step 2: tier2Aligned=1, got ${result.tier2Aligned}`);
    assert(result.tier1Aligned === 0, "Step 2: not tier1");
    assert(dedupCalls >= 1, `Step 2: dedup judge called, got ${dedupCalls}`);
    const after = readFileSync(join(repoRoot, "src/auth.ts"), "utf8");
    assert(after.includes("// §DEC-2222222"), "Step 2: source cites seeded DEC");
    console.log(`  ✓ Step 2 — Tier 2 Pass 1 dedup \`same\` cite (haikuCalls=${result.haikuCalls})`);
  }

  // ── Step 3 — Tier 3 creation judge `decision` → fresh DEC ─────────
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * We chose the BullMQ background-job library over Sidekiq because the runtime",
      " * is Node-native and the Redis connection model matches our existing infra.",
      " * Sidekiq would have required a separate Ruby runtime.",
      " */",
      "export function jobs() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/jobs.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/jobs.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => "decision",
    });
    assert(result.decsCreated === 1, `Step 3: decsCreated=1, got ${result.decsCreated}`);
    const ground = join(repoRoot, ".cairn", "ground", "decisions");
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(ground).filter((n) => n.endsWith(".md"));
    assert(entries.length === 1, `Step 3: one DEC file written, got ${entries.length}`);
    const decId = entries[0]?.replace(/\.md$/, "") ?? "";
    assert(/^DEC-[0-9a-f]{7,}$/.test(decId), `Step 3: DEC id format, got ${decId}`);
    const decBody = readFileSync(join(ground, `${decId}.md`), "utf8");
    assert(decBody.includes("BullMQ"), "Step 3: DEC body cites verbatim prose");
    assert(decBody.includes("status: accepted"), "Step 3: DEC auto-promoted");
    assert(decBody.includes("sot_kind: ledger"), "Step 3: ledger SoT");
    assert(decBody.includes("capture_source: layer-a-sot-align"), "Step 3: capture_source stamped");
    const after = readFileSync(join(repoRoot, "src/jobs.ts"), "utf8");
    assert(after.includes(`// §${decId}`), "Step 3: source carries fresh §DEC cite");
    assert(!after.includes("BullMQ"), "Step 3: original prose stripped");
    console.log(`  ✓ Step 3 — Tier 3 created ${decId}, source strip-replaced`);
  }

  // ── Step 4 — Tier 3 `descriptive` → no-op, source untouched ──────
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * Returns the merged user object. Maps the database row to the API shape",
      " * expected by the frontend. Throws when the row is missing required fields.",
      " * @returns User",
      " */",
      "export function getUser() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/user.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/user.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => "descriptive",
    });
    assert(result.descriptive === 1, `Step 4: descriptive=1, got ${result.descriptive}`);
    assert(result.decsCreated === 0, "Step 4: no DEC created on descriptive");
    const after = readFileSync(join(repoRoot, "src/user.ts"), "utf8");
    assert(after === source, "Step 4: source untouched on descriptive verdict");
    console.log("  ✓ Step 4 — descriptive verdict leaves source alone");
  }

  // ── Step 5 — Per-Write cap defers excess to staleness ─────────────
  {
    const repoRoot = mkRepoRoot();
    // Write a file with 7 essay JSDoc blocks — the per-Write cap is 5.
    // Each block must (a) clear the Tier-3 ledger-worthy gate and (b) stay
    // distinct so the in-loop sot-cache append doesn't let later blocks
    // dedup-cite an earlier emit. So each is a genuine "chose X over Y
    // because Z" decision (clears the gate via decision-shape) with a
    // varied verb/connector and a distinct topic (keeps Jaccard < 0.3).
    const decisionBlocks: string[][] = [
      [
        "We chose Postgres over MySQL for the primary store because JSONB support",
        "and logical replication match the nightly analytics workload.",
      ],
      [
        "We selected a leaky-bucket limiter rather than a fixed-window counter",
        "because burst tolerance matters for the anonymous traffic tier.",
      ],
      [
        "We picked HS512 instead of RS256 for token signing because the deployment",
        "topology lacks a key-rotation surface today.",
      ],
      [
        "We adopted RabbitMQ over Kafka for the order events bus because operational",
        "simplicity outweighs partition durability for this team.",
      ],
      [
        "We decided on bcrypt rather than argon2 for password hashing because its",
        "cost factor maps cleanly to the login latency budget.",
      ],
      [
        "We standardize on append-only partitioned tables instead of mutable rows",
        "for the audit log because immutability eases compliance export.",
      ],
      [
        "We went with BullMQ over Sidekiq for background jobs because the runtime",
        "is Node-native and Redis is already deployed in this cluster.",
      ],
    ];
    const blocks: string[] = decisionBlocks.map((lines, i) =>
      [
        "/**",
        ...lines.map((l) => ` * ${l}`),
        " */",
        `export function component${i + 1}() {}`,
      ].join("\n"),
    );
    writeFile(repoRoot, "src/many.ts", blocks.join("\n\n") + "\n");
    commitAll(repoRoot);

    let creationCalls = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "src/many.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "decision";
      },
    });
    assert(result.haikuCalls <= 5, `Step 5: haikuCalls capped at 5, got ${result.haikuCalls}`);
    assert(creationCalls <= 5, `Step 5: creation judge called ≤5, got ${creationCalls}`);
    assert(
      result.deferredToStaleness >= 2,
      `Step 5: at least 2 deferred to staleness, got ${result.deferredToStaleness}`,
    );
    const stalenessLog = join(repoRoot, ".cairn", "staleness", "layer-a-deferred.jsonl");
    assert(existsSync(stalenessLog), "Step 5: layer-a-deferred.jsonl exists");
    const lines = readFileSync(stalenessLog, "utf8").split("\n").filter((l) => l.length > 0);
    assert(lines.length >= 2, `Step 5: ≥2 deferred lines, got ${lines.length}`);
    console.log(
      `  ✓ Step 5 — cap=5 honored (haiku=${result.haikuCalls}, deferred=${result.deferredToStaleness})`,
    );
  }

  // ── Step 6 — Two similar blocks in the same Write produce one DEC + one cite
  {
    const repoRoot = mkRepoRoot();
    const blockA = [
      "/**",
      " * We chose RabbitMQ over Kafka for the order events bus because the",
      " * throughput requirement is bounded at 5k/sec and operational simplicity",
      " * outweighs Kafka's partition-level durability story for this team.",
      " */",
      "export function busA() {}",
    ].join("\n");
    // Same prose duplicated verbatim — the SECOND occurrence should hit
    // the just-emitted DEC via the in-loop sot-cache append, not produce
    // a second ledger entry.
    const blockB = [
      "/**",
      " * We chose RabbitMQ over Kafka for the order events bus because the",
      " * throughput requirement is bounded at 5k/sec and operational simplicity",
      " * outweighs Kafka's partition-level durability story for this team.",
      " */",
      "export function busB() {}",
    ].join("\n");
    writeFile(repoRoot, "src/dup.ts", `${blockA}\n\n${blockB}\n`);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/dup.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => "decision",
    });
    assert(result.decsCreated === 1, `Step 6: exactly one DEC emitted, got ${result.decsCreated}`);
    assert(
      result.tier1Aligned + result.tier2Aligned === 1,
      `Step 6: second block becomes a cite (tier1+tier2=${result.tier1Aligned + result.tier2Aligned})`,
    );
    const { readdirSync } = await import("node:fs");
    const decs = readdirSync(join(repoRoot, ".cairn/ground/decisions"))
      .filter((n) => n.endsWith(".md"));
    assert(decs.length === 1, `Step 6: one DEC file on disk, got ${decs.length}`);
    console.log("  ✓ Step 6 — in-loop sot-cache append: dup block becomes cite, not 2nd DEC");
  }

  // ── Step 7 — Markdown files skipped entirely ─────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFile(
      repoRoot,
      "docs/architecture.md",
      [
        "# Architecture",
        "",
        "We chose Postgres over MySQL because the rich JSON column support and",
        "logical replication story matched the team's needs. Migration was",
        "straightforward and the operational surface stayed familiar.",
        "",
      ].join("\n"),
    );
    commitAll(repoRoot);
    let creationCalls = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "docs/architecture.md",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "decision";
      },
    });
    assert(result.blocksConsidered === 0, "Step 7: markdown extraction skipped");
    assert(result.decsCreated === 0, "Step 7: no DEC created from markdown");
    assert(creationCalls === 0, "Step 7: no Haiku call on markdown");
    const after = readFileSync(join(repoRoot, "docs/architecture.md"), "utf8");
    assert(after.includes("Postgres over MySQL"), "Step 7: markdown narrative untouched");
    assert(!after.includes("// §DEC-"), "Step 7: no // §DEC line injected into markdown");
    console.log("  ✓ Step 7 — markdown files skipped (operator narrative preserved)");
  }

  // ── Step 8 — Tier 2 Pass 2 augments → sibling DEC + double-cite ─
  {
    const repoRoot = mkRepoRoot();
    const seedBody =
      "Use bcrypt over scrypt for password hashing because the operational " +
      "surface across our deployment platforms is uniform and bcrypt's cost " +
      "factor maps cleanly to our SLO budget.";
    seedAcceptedDec(repoRoot, "DEC-7777777", seedBody);

    // Block adds rationale beyond the seed body so Pass 2 calls augments.
    const source = [
      "/**",
      " * Use bcrypt over scrypt for password hashing because the operational",
      " * surface across our deployment platforms is uniform and bcrypt's cost",
      " * factor maps cleanly to our SLO budget. ALSO: rotation is forbidden",
      " * mid-flight to avoid lockout cascades during rolling deploys.",
      " */",
      "export function hash() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/hash.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/hash.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "ambiguous",
      mockDedupJudgePass2: async () => "augments",
      mockDeltaExtract: async () =>
        "rotation is forbidden mid-flight to avoid lockout cascades during rolling deploys.",
      mockDeltaClassify: async () => "constraint",
      mockCreationJudgePass1: async () => "descriptive",
    });
    assert(result.augmentsInvs === 1, `Step 8: augments INV emitted, got ${result.augmentsInvs}`);
    assert(result.augmentsDecs === 0, "Step 8: no augments DEC (delta classified as constraint)");
    const { readdirSync } = await import("node:fs");
    const invs = readdirSync(join(repoRoot, ".cairn/ground/invariants"))
      .filter((n) => n.endsWith(".md"));
    assert(invs.length === 1, `Step 8: one INV file emitted, got ${invs.length}`);
    const invId = invs[0]?.replace(/\.md$/, "") ?? "";
    const invBody = readFileSync(
      join(repoRoot, ".cairn/ground/invariants", `${invId}.md`),
      "utf8",
    );
    assert(invBody.includes("derived_from: DEC-7777777"), "Step 8: INV.derived_from = existing DEC");
    assert(invBody.includes("rotation is forbidden"), "Step 8: INV body = delta only");
    const after = readFileSync(join(repoRoot, "src/hash.ts"), "utf8");
    assert(after.includes("// §DEC-7777777"), "Step 8: existing § token preserved");
    assert(after.includes(`// §${invId}`), "Step 8: source carries new sibling cite alongside existing");
    console.log(`  ✓ Step 8 — Tier 2 Pass 2 augments → sibling ${invId}, double-cite`);
  }

  // ── Step 9 — Tier 3 Pass 2 escalation lifts ambiguous Pass 1 ─────
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * The retry budget for upstream API calls follows an exponential backoff",
      " * starting at 200ms and capping at 5s. We chose this curve over linear",
      " * because the error spike profile is heavy-tailed.",
      " */",
      "export function retry() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/retry.ts", source);
    commitAll(repoRoot);

    let pass1Hit = 0;
    let pass2Hit = 0;
    const result = await alignFile({
      repoRoot,
      filePath: "src/retry.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        pass1Hit += 1;
        return "ambiguous";
      },
      mockCreationJudgePass2: async () => {
        pass2Hit += 1;
        return "decision";
      },
    });
    assert(pass1Hit === 1, `Step 9: Pass 1 fired once, got ${pass1Hit}`);
    assert(pass2Hit === 1, `Step 9: Pass 2 escalation fired, got ${pass2Hit}`);
    assert(result.decsCreated === 1, `Step 9: DEC emitted from Pass 2 verdict`);
    assert(result.haikuPass1Calls === 1, "Step 9: pass1 counter");
    assert(result.haikuPass2Calls === 1, "Step 9: pass2 counter");
    console.log("  ✓ Step 9 — Tier 3 Pass 2 escalation works");
  }

  // ── Step 8b — Augments delta = NO_DELTA → treated as same, plain cite
  {
    const repoRoot = mkRepoRoot();
    const seedBody =
      "Use bcrypt over scrypt for password hashing because operational " +
      "topology is uniform across deploy platforms and bcrypt's cost " +
      "factor maps cleanly to the SLO budget.";
    seedAcceptedDec(repoRoot, "DEC-7777771", seedBody);

    // Block is similar but reworded enough to MISS Tier 1 (Jaccard < 0.85
    // or shingle overlap < 0.6) while still landing as a Jaccard candidate
    // ≥ 0.3. Lengths kept far enough apart to fail Tier 1's ratio bound.
    const source = [
      "/**",
      " * Bcrypt is preferred over scrypt for hashing user passwords because",
      " * deployment topology stays uniform and the cost factor lines up with",
      " * the latency budget.",
      " */",
      "export function h() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/h.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/h.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "ambiguous",
      mockDedupJudgePass2: async () => "augments",
      mockDeltaExtract: async () => "NO_DELTA",
      mockCreationJudgePass1: async () => "descriptive",
    });
    assert(result.tier2Aligned === 1, `Step 8b: NO_DELTA → cite, got tier2=${result.tier2Aligned}`);
    assert(result.augmentsInvs === 0 && result.augmentsDecs === 0, "Step 8b: no sibling emitted");
    const after = readFileSync(join(repoRoot, "src/h.ts"), "utf8");
    assert(after.includes("// §DEC-7777771"), "Step 8b: source plain-cited to seed");
    console.log("  ✓ Step 8b — NO_DELTA collapses augments to plain cite");
  }

  // ── Step 8c — Augments delta = rationale → sibling DEC, not INV ─
  {
    const repoRoot = mkRepoRoot();
    const seedBody =
      "Always sign tokens with HS512 because operational topology lacks " +
      "key rotation infrastructure today.";
    seedAcceptedDec(repoRoot, "DEC-7777772", seedBody);

    const source = [
      "/**",
      " * Always sign tokens with HS512 because operational topology lacks",
      " * key rotation infrastructure today. The runtime cost is negligible",
      " * versus RS256 which gave us p99 latency wins on the auth path.",
      " */",
      "export function s() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/s.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/s.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "ambiguous",
      mockDedupJudgePass2: async () => "augments",
      mockDeltaExtract: async () =>
        "The runtime cost is negligible versus RS256 which gave us p99 latency wins on the auth path.",
      mockDeltaClassify: async () => "rationale",
      mockCreationJudgePass1: async () => "descriptive",
    });
    assert(result.augmentsDecs === 1, `Step 8c: augments DEC sibling, got ${result.augmentsDecs}`);
    assert(result.augmentsInvs === 0, "Step 8c: no INV (delta classified as rationale)");
    const { readdirSync } = await import("node:fs");
    const decs = readdirSync(join(repoRoot, ".cairn/ground/decisions"))
      .filter((n) => n.endsWith(".md") && n !== "DEC-7777772.md");
    assert(decs.length === 1, `Step 8c: one new DEC sibling, got ${decs.length}`);
    const newDecId = decs[0]?.replace(/\.md$/, "") ?? "";
    const decBody = readFileSync(
      join(repoRoot, ".cairn/ground/decisions", `${newDecId}.md`),
      "utf8",
    );
    assert(decBody.includes("related: DEC-7777772"), "Step 8c: sibling DEC.related = parent");
    assert(decBody.includes("p99 latency wins"), "Step 8c: sibling body = delta only");
    const after = readFileSync(join(repoRoot, "src/s.ts"), "utf8");
    assert(after.includes("// §DEC-7777772"), "Step 8c: existing § token preserved");
    assert(after.includes(`// §${newDecId}`), "Step 8c: sibling cite added");
    console.log(`  ✓ Step 8c — Tier 2 Pass 2 augments rationale → sibling ${newDecId}`);
  }

  // ── Step 9b — Verdict cache reuse: same prose twice = 1 Haiku call total
  {
    const repoRoot = mkRepoRoot();
    const source = [
      "/**",
      " * We chose ESM over CommonJS for the publish target because the",
      " * runtime is Node 20+ and the consumer ecosystem has stabilized on",
      " * ESM imports across our internal package boundary.",
      " */",
      "export function pkg() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/pkg.ts", source);
    commitAll(repoRoot);

    let creationCalls = 0;
    const r1 = await alignFile({
      repoRoot,
      filePath: "src/pkg.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "decision";
      },
    });
    assert(r1.decsCreated === 1, "Step 9b: first run emits DEC");
    assert(creationCalls === 1, "Step 9b: first run = 1 Haiku call");

    // Restore original prose then re-run — exercises the verdict cache.
    writeFile(repoRoot, "src/pkg.ts", source);
    const r2 = await alignFile({
      repoRoot,
      filePath: "src/pkg.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => {
        creationCalls += 1;
        return "decision";
      },
    });
    assert(creationCalls === 1, `Step 9b: second run reuses cache, total Haiku=${creationCalls}`);
    assert(r2.haikuPass1Calls === 0, `Step 9b: r2 pass1Calls=0, got ${r2.haikuPass1Calls}`);
    console.log("  ✓ Step 9b — verdict cache prevents redundant Haiku calls");
  }

  // ── Step 10 — Pass 2 still ambiguous → alignment-pending file ────
  {
    const repoRoot = mkRepoRoot();
    // Gate-passing (decision-shape: "chose … because") so the block reaches
    // the creation judge, but vague enough that the mock-forced ambiguous
    // verdict on both passes is plausible — exercises the pending path.
    const source = [
      "/**",
      " * We chose to defer the ordering guarantee because the upstream service",
      " * behavior is unpredictable and the team has not aligned on the semantics",
      " * yet; revisit once the contract stabilizes.",
      " */",
      "export function thing() {}",
    ].join("\n") + "\n";
    writeFile(repoRoot, "src/thing.ts", source);
    commitAll(repoRoot);

    const result = await alignFile({
      repoRoot,
      filePath: "src/thing.ts",
      sessionId: null,
      mockDedupJudgePass1: async () => "different",
      mockCreationJudgePass1: async () => "ambiguous",
      mockCreationJudgePass2: async () => "ambiguous",
    });
    assert(result.pending === 1, `Step 10: pending=1, got ${result.pending}`);
    assert(result.decsCreated === 0, "Step 10: no DEC on Pass 2 ambiguous");
    const pendingDir = join(repoRoot, ".cairn/ground/alignment-pending");
    assert(existsSync(pendingDir), "Step 10: alignment-pending dir created");
    const { readdirSync } = await import("node:fs");
    const pending = readdirSync(pendingDir).filter((n) => n.endsWith(".md"));
    assert(pending.length === 1, `Step 10: one pending file, got ${pending.length}`);
    const pendingBody = readFileSync(join(pendingDir, pending[0]!), "utf8");
    assert(pendingBody.includes("kind: tier3-ambiguous"), "Step 10: kind frontmatter");
    assert(pendingBody.includes("source_file: src/thing.ts"), "Step 10: source_file frontmatter");
    assert(pendingBody.includes("revisit once the contract stabilizes"), "Step 10: prose preserved verbatim");
    // Source untouched — operator's narrative + verbatim block stays.
    const after = readFileSync(join(repoRoot, "src/thing.ts"), "utf8");
    assert(after === source, "Step 10: source untouched on alignment-pending");
    console.log("  ✓ Step 10 — Pass 2 ambiguous → alignment-pending file written");
  }

  cleanup();
  console.log("\nsmoke-sot-align — pass");
}

main().catch((err) => {
  console.error("smoke-sot-align — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
