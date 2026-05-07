#!/usr/bin/env tsx
/**
 * smoke-sot-body — exercises `LensResolver.resolveDecisionBody` and
 * `resolveInvariantBody` (plan §10).
 *
 *   Step 1 — Ledger-kind: body comes from the .md entity file and a
 *            snapshot is written to .cairn/cache/sot-rendered/.
 *   Step 2 — Path-kind: body comes from the live source via
 *            anchor-map; line_range slicing applied.
 *   Step 3 — Path-kind with the file deleted: resolver falls back to
 *            the snapshot from a prior successful read.
 *   Step 4 — Bindings absent: resolver falls back to ledger lookup so
 *            v0.4.x adopters without sot-bindings.yaml still get
 *            bodies.
 *   Step 5 — Invariant body resolution mirrors decisions.
 *   Step 6 — Path-kind with no anchor-map entry: empty body, no
 *            crash.
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
  bindDec,
  emptyAnchorMap,
  emptySotBindings,
  setAnchor,
  writeAnchorMap,
  writeSotBindings,
} from "@isaacriehm/cairn-core";
import { LensResolver } from "../dist/resolver.js";

const cleanups: string[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lens-sot-body-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function seedDec(repoRoot: string, id: string, title: string, body: string, sotPath = "ledger"): void {
  const decDir = join(repoRoot, ".cairn", "ground", "decisions");
  mkdirSync(decDir, { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: adr",
    "status: accepted",
    "audience: dual",
    "generated: 2026-01-01T00:00:00Z",
    "verified-at: 2026-01-01T00:00:00Z",
    "decided_at: 2026-01-01T00:00:00Z",
    "decided_by: smoke",
    `sot_kind: ${sotPath === "ledger" ? "ledger" : "path"}`,
    `sot_path: ${sotPath}`,
    'sot_content_hash: "0000000000000000000000000000000000000000000000000000000000000000"',
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(join(decDir, `${id}.md`), fm, "utf8");
  // Also write minimal ledger.yaml entry so resolveDecision succeeds.
  const ledgerYaml = `- id: ${id}\n  title: ${title}\n  status: accepted\n`;
  writeFileSync(join(decDir, "decisions.ledger.yaml"), ledgerYaml, "utf8");
  // Wire bindings for path-kind cases.
  let bindings;
  try {
    const path = join(repoRoot, ".cairn", "ground", "sot-bindings.yaml");
    if (existsSync(path)) {
      const { readSotBindings } = require("@isaacriehm/cairn-core");
      bindings = readSotBindings(repoRoot);
    } else {
      bindings = emptySotBindings();
    }
  } catch {
    bindings = emptySotBindings();
  }
  writeSotBindings(repoRoot, bindDec(bindings, id, sotPath));
}

function seedInvariant(repoRoot: string, id: string, title: string, body: string): void {
  const invDir = join(repoRoot, ".cairn", "ground", "invariants");
  mkdirSync(invDir, { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: invariant",
    "status: active",
    "audience: dual",
    "generated: 2026-01-01T00:00:00Z",
    "verified-at: 2026-01-01T00:00:00Z",
    "sot_kind: ledger",
    "sot_path: ledger",
    'sot_content_hash: "0000000000000000000000000000000000000000000000000000000000000000"',
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(join(invDir, `${id}.md`), fm, "utf8");
  writeFileSync(
    join(invDir, "invariants.ledger.yaml"),
    `- id: ${id}\n  title: ${title}\n  status: active\n`,
    "utf8",
  );
}

function runSmoke(): void {
  console.log("smoke-sot-body — start");

  // ── Step 1 — Ledger-kind body + snapshot write ─────────────────
  {
    const repoRoot = mkFixture();
    const body = "Pin Postgres at 15. Legacy ETL depends on it. Revisit after rewrite.";
    seedDec(repoRoot, "DEC-aaaaaaa", "Postgres pin", body);
    const r = new LensResolver(repoRoot).resolveDecisionBody("DEC-aaaaaaa");
    assert(r.status === "accepted", `Step 1: status=accepted, got ${r.status}`);
    assert(r.sot_kind === "ledger", `Step 1: sot_kind=ledger, got ${r.sot_kind}`);
    assert(r.body.includes("Pin Postgres"), `Step 1: body present, got ${r.body.slice(0, 30)}`);
    assert(r.fromCache === false, "Step 1: live read, not cached");
    const snapPath = join(repoRoot, ".cairn", "cache", "sot-rendered", "DEC-aaaaaaa.md");
    assert(existsSync(snapPath), "Step 1: snapshot written");
    assert(readFileSync(snapPath, "utf8").includes("Pin Postgres"), "Step 1: snapshot has body");
    console.log("  ✓ Step 1 — Ledger-kind body + snapshot");
  }

  // ── Step 2 — Path-kind body via anchor-map ─────────────────────
  {
    const repoRoot = mkFixture();
    const docBody = [
      "# Auth design",
      "",
      "We sign tokens via HS512 instead of RS256 today. Topology has no key",
      "rotation surface; KMS arrival reopens this. JWT auth path uses HS512.",
      "",
      "(other prose)",
    ].join("\n");
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs/auth.md"), docBody, "utf8");
    seedDec(repoRoot, "DEC-bbbbbbb", "JWT signing", "(body unused — path SoT)", "docs/auth.md#tokens");

    let anchors = emptyAnchorMap();
    anchors = setAnchor(anchors, "tokens", {
      file: "docs/auth.md",
      current_anchor: "tokens",
      content_hash: "0".repeat(64),
      line_range: [3, 4],
      kind: "doc",
    });
    writeAnchorMap(repoRoot, anchors);

    const r = new LensResolver(repoRoot).resolveDecisionBody("DEC-bbbbbbb");
    assert(r.sot_kind === "path", `Step 2: sot_kind=path, got ${r.sot_kind}`);
    assert(r.sot_path === "docs/auth.md#tokens", "Step 2: sot_path round-trip");
    assert(r.body.includes("HS512"), `Step 2: body sliced from doc, got ${r.body.slice(0, 60)}`);
    assert(!r.body.includes("(other prose)"), "Step 2: line_range honored");
    assert(r.fromCache === false, "Step 2: live read");
    console.log("  ✓ Step 2 — Path-kind body via anchor-map line_range");
  }

  // ── Step 3 — Path-kind with file deleted → cache fallback ──────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(
      join(repoRoot, "docs/auth.md"),
      "# H\n\nWe sign tokens via HS512 today. KMS later.\n",
      "utf8",
    );
    seedDec(repoRoot, "DEC-ccccccc", "JWT signing", "(unused)", "docs/auth.md#tokens");
    let anchors = emptyAnchorMap();
    anchors = setAnchor(anchors, "tokens", {
      file: "docs/auth.md",
      current_anchor: "tokens",
      content_hash: "0".repeat(64),
      line_range: [3, 3],
      kind: "doc",
    });
    writeAnchorMap(repoRoot, anchors);

    const resolver = new LensResolver(repoRoot);
    const live = resolver.resolveDecisionBody("DEC-ccccccc");
    assert(live.body.includes("HS512"), "Step 3 prep: live body cached");

    // Delete the source file; subsequent read should fall back to cache.
    rmSync(join(repoRoot, "docs/auth.md"), { force: true });
    const cached = resolver.resolveDecisionBody("DEC-ccccccc");
    assert(cached.fromCache === true, "Step 3: cache fallback engaged");
    assert(cached.body.includes("HS512"), "Step 3: cached body returned");
    console.log("  ✓ Step 3 — Path-kind: cache fallback when source vanishes");
  }

  // ── Step 4 — No bindings → ledger fallback ─────────────────────
  {
    const repoRoot = mkFixture();
    // Skip writeSotBindings — leave bindings absent.
    const decDir = join(repoRoot, ".cairn", "ground", "decisions");
    mkdirSync(decDir, { recursive: true });
    writeFileSync(
      join(decDir, "DEC-ddddddd.md"),
      [
        "---",
        "id: DEC-ddddddd",
        "title: legacy DEC",
        "status: accepted",
        "sot_kind: ledger",
        "sot_path: ledger",
        'sot_content_hash: "0000000000000000000000000000000000000000000000000000000000000000"',
        "---",
        "",
        "Legacy body without sot-bindings.yaml.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(decDir, "decisions.ledger.yaml"),
      `- id: DEC-ddddddd\n  title: legacy DEC\n  status: accepted\n`,
      "utf8",
    );
    const r = new LensResolver(repoRoot).resolveDecisionBody("DEC-ddddddd");
    assert(r.body.includes("Legacy body"), "Step 4: ledger body served without bindings");
    assert(
      r.sot_kind === "unknown" || r.sot_kind === "ledger",
      `Step 4: sot_kind unknown/ledger, got ${r.sot_kind}`,
    );
    console.log("  ✓ Step 4 — Ledger fallback when bindings absent");
  }

  // ── Step 5 — Invariant body resolution ─────────────────────────
  {
    const repoRoot = mkFixture();
    seedInvariant(repoRoot, "INV-2222222", "auth tokens expire ≤24h", "All bearer tokens MUST expire within 24h.");
    const r = new LensResolver(repoRoot).resolveInvariantBody("INV-2222222");
    assert(r.status === "active", `Step 5: status=active, got ${r.status}`);
    assert(r.body.includes("bearer tokens"), `Step 5: body served, got ${r.body.slice(0, 30)}`);
    console.log("  ✓ Step 5 — Invariant body resolution");
  }

  // ── Step 6 — Path-kind without matching anchor-map entry ───────
  {
    const repoRoot = mkFixture();
    seedDec(repoRoot, "DEC-eeeeeee", "Doc DEC", "(unused)", "docs/missing.md#nope");
    writeAnchorMap(repoRoot, emptyAnchorMap());
    const r = new LensResolver(repoRoot).resolveDecisionBody("DEC-eeeeeee");
    assert(r.sot_kind === "path", `Step 6: sot_kind=path, got ${r.sot_kind}`);
    assert(r.body === "", "Step 6: empty body when anchor missing");
    assert(r.fromCache === false, "Step 6: no cache to fall back on");
    console.log("  ✓ Step 6 — Path-kind no-match returns empty body without crashing");
  }

  console.log("smoke-sot-body — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
