#!/usr/bin/env tsx
/**
 * smoke-curator-validate — quality-bar acceptance for the Phase 9c-emit
 * validators.
 *
 * Feeds 20+ sample entries (clean + every documented failure mode) into
 * `validateEntry` and asserts the expected drop-vs-emit decisions.
 * Sample categories:
 *   - clean DEC + clean INV (both pass)
 *   - mid-sentence title (drop: title-no-cap)
 *   - JSX-leaked title (drop: title-truncated-or-jsx)
 *   - truncated title (drop: title-truncated-or-jsx)
 *   - over-length title (drop: title-length)
 *   - empty title (drop: title-length)
 *   - title with trailing comma / colon (drop: title-trailing-punct)
 *   - body missing required section (drop: body-missing-…)
 *   - JSDoc-tag-leaked body (drop: jsdoc-tag-leak)
 *   - title pasted into body (drop: title-pasted-in-body)
 *   - missing scope_globs (drop: no-scope-globs)
 *   - missing evidence (drop: no-evidence)
 *   - evidence file missing on disk (drop: evidence-missing:…)
 *
 * The validators are pure functions over a synthetic FinalEntry; the
 * smoke creates a temp repo only to give `evidence_files` references
 * something real (and something missing) to resolve against.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  filterExistingEvidence,
  stripLineRange,
  validateEntry,
  type FinalEntry,
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
      // best-effort
    }
  }
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-curator-validate-"));
  cleanups.push(dir);
  return dir;
}

function seedFile(repo: string, rel: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "// seeded for smoke\n");
}

const cleanDecBody = [
  "## Context",
  "Operators interact with rate-limited login endpoints.",
  "",
  "## Decision",
  "Cap login attempts to 5 per IP per minute and return 429 above that.",
  "",
  "## Why",
  "Brute-force surface needs to stay narrow without locking real users out.",
].join("\n");

const cleanInvBody = [
  "## Context",
  "Sessions persist to the edge cache for 24h.",
  "",
  "## Invariant",
  "Every session lookup MUST verify the cache TTL has not elapsed.",
  "",
  "## Why",
  "Stale sessions allow privilege escalation after operator deactivation.",
].join("\n");

interface Case {
  name: string;
  entry: FinalEntry;
  expectValid: boolean;
  expectReason?: string;
}

function buildCases(repo: string): Case[] {
  // Real evidence file the validator can resolve.
  const evReal = "core/src/auth/session.ts";
  const evReal2 = "core/src/auth/login.ts";
  seedFile(repo, evReal);
  seedFile(repo, evReal2);

  const baseDec: FinalEntry = {
    kind: "DEC",
    title: "Cap login attempts to 5 per minute per IP",
    body: cleanDecBody,
    scope_globs: ["core/src/auth/**"],
    evidence_files: [`${evReal2}:42-58`],
    topic_tags: ["auth", "rate-limit"],
  };
  const baseInv: FinalEntry = {
    kind: "INV",
    title: "Reject sessions older than 24h at every cache lookup",
    body: cleanInvBody,
    scope_globs: ["core/src/auth/**"],
    evidence_files: [evReal],
    topic_tags: ["auth", "session"],
  };

  return [
    { name: "clean DEC", entry: baseDec, expectValid: true },
    { name: "clean INV", entry: baseInv, expectValid: true },
    {
      name: "mid-sentence title",
      entry: { ...baseDec, title: "and the LOGIN_FAILED audit row must" },
      expectValid: false,
      expectReason: "title-no-cap",
    },
    {
      name: "JSX block-comment title",
      entry: { ...baseDec, title: "{/* 02.2-04: Context column ... */}" },
      expectValid: false,
      expectReason: "title-truncated-or-jsx",
    },
    {
      name: "truncated title",
      entry: { ...baseDec, title: "Reject login when token expired..." },
      expectValid: false,
      expectReason: "title-truncated-or-jsx",
    },
    {
      name: "over-length title",
      entry: {
        ...baseDec,
        title:
          "Cap login attempts to 5 per IP per minute and also enforce per-user lockouts after 10 fails",
      },
      expectValid: false,
      expectReason: "title-length",
    },
    {
      name: "empty title",
      entry: { ...baseDec, title: "" },
      expectValid: false,
      expectReason: "title-length",
    },
    {
      name: "title with trailing comma",
      entry: { ...baseDec, title: "Cap login attempts to 5 per IP per minute," },
      expectValid: false,
      expectReason: "title-trailing-punct",
    },
    {
      name: "title with trailing colon",
      entry: { ...baseDec, title: "Cap login attempts to 5 per IP per minute:" },
      expectValid: false,
      expectReason: "title-trailing-punct",
    },
    {
      name: "body missing Context",
      entry: { ...baseDec, body: cleanDecBody.replace("## Context", "## Background") },
      expectValid: false,
      expectReason: "body-missing-## Context",
    },
    {
      name: "body missing Decision",
      entry: { ...baseDec, body: cleanDecBody.replace("## Decision", "## Approach") },
      expectValid: false,
      expectReason: "body-missing-## Decision",
    },
    {
      name: "body missing Why",
      entry: { ...baseDec, body: cleanDecBody.replace("## Why", "## Notes") },
      expectValid: false,
      expectReason: "body-missing-## Why",
    },
    {
      name: "INV body missing Invariant section",
      entry: { ...baseInv, body: cleanInvBody.replace("## Invariant", "## Rule") },
      expectValid: false,
      expectReason: "body-missing-## Invariant",
    },
    {
      name: "JSDoc tag leak (@domain)",
      entry: {
        ...baseDec,
        body: `${cleanDecBody}\n\n@domain auth\n@orgScope global\n`,
      },
      expectValid: false,
      expectReason: "jsdoc-tag-leak",
    },
    {
      name: "JSDoc tag leak (@see)",
      entry: { ...baseDec, body: `${cleanDecBody}\n\n@see ./other\n` },
      expectValid: false,
      expectReason: "jsdoc-tag-leak",
    },
    {
      name: "title pasted in body",
      entry: {
        ...baseDec,
        body: `${cleanDecBody}\n\nNote: ${baseDec.title}`,
      },
      expectValid: false,
      expectReason: "title-pasted-in-body",
    },
    {
      name: "no scope_globs",
      entry: { ...baseDec, scope_globs: [] },
      expectValid: false,
      expectReason: "no-scope-globs",
    },
    // Evidence is corroboration, not a gate (see validate.ts header). An
    // entry with no evidence, or evidence that doesn't resolve on disk, is
    // STILL valid — `filterExistingEvidence` strips dangling refs at emit
    // time but the decision survives. Regression guard: a docs/rules corpus
    // citing unverifiable paths must not be discarded into an empty ledger.
    {
      name: "no evidence_files — still valid (evidence is soft)",
      entry: { ...baseDec, evidence_files: [] },
      expectValid: true,
    },
    {
      name: "evidence missing on disk — still valid",
      entry: { ...baseDec, evidence_files: ["core/src/auth/nonexistent.ts:1-10"] },
      expectValid: true,
    },
    {
      name: "evidence missing on disk (#L anchor) — still valid",
      entry: { ...baseDec, evidence_files: ["core/src/auth/nope.ts#L1-L10"] },
      expectValid: true,
    },
  ];
}

function runSmoke(): void {
  console.log("smoke-curator-validate — start");

  const repo = mkRepo();
  const cases = buildCases(repo);

  // Sanity-check stripLineRange behavior.
  assert(
    stripLineRange("a/b.ts:42-58") === "a/b.ts",
    "stripLineRange colon range",
  );
  assert(
    stripLineRange("a/b.ts:42") === "a/b.ts",
    "stripLineRange single line",
  );
  assert(
    stripLineRange("a/b.ts#L42-L58") === "a/b.ts",
    "stripLineRange anchor form",
  );
  assert(
    stripLineRange("a/b.ts") === "a/b.ts",
    "stripLineRange bare path",
  );

  // filterExistingEvidence keeps resolvable refs, drops danglers, dedups.
  const evReal = "core/src/auth/session.ts"; // seeded by buildCases
  const filtered = filterExistingEvidence(
    [`${evReal}:1-5`, "core/src/auth/ghost.ts:1-5", `${evReal}:1-5`],
    repo,
  );
  assert(
    filtered.length === 1 && filtered[0] === `${evReal}:1-5`,
    `filterExistingEvidence: expected [${evReal}:1-5], got ${JSON.stringify(filtered)}`,
  );
  assert(
    filterExistingEvidence(["nope/a.ts", "nope/b.ts"], repo).length === 0,
    "filterExistingEvidence: all-dangling → empty",
  );

  for (const c of cases) {
    const result = validateEntry(c.entry);
    if (c.expectValid) {
      assert(
        result.valid === true,
        `case "${c.name}": expected valid, got rejection ${result.rejectReason}`,
      );
    } else {
      assert(
        result.valid === false,
        `case "${c.name}": expected drop, but validator said valid`,
      );
      assert(
        result.rejectReason === c.expectReason,
        `case "${c.name}": expected reason ${c.expectReason}, got ${result.rejectReason}`,
      );
    }
    console.log(`  ✓ ${c.name}`);
  }

  console.log(`smoke-curator-validate — pass (${cases.length} cases)`);
}

try {
  runSmoke();
} finally {
  cleanup();
}
