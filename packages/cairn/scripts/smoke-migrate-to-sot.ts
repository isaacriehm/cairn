#!/usr/bin/env tsx
/**
 * smoke-migrate-to-sot — exercises `/tmp/cairn-v0.5.0-migrate.mjs`
 * against a synthesized v0.4.x-shape repo (plan §7.5).
 *
 * Validates that running the migration script:
 *   - Stamps `sot_kind` / `sot_path` / `sot_content_hash` onto every
 *     existing DEC + INV ledger entity.
 *   - Initializes the four ground-state files.
 *   - Seeds `sot-bindings.yaml` + `sot-cache.yaml` from the
 *     post-stamp ledger entities.
 *   - Installs the Layer B `pre-commit` hook idempotently.
 *
 * Re-running the script against an already-migrated repo is a no-op.
 *
 * Steps:
 *   1. Synthesize a v0.4.x repo, run migration, assert sot_* fields
 *      stamped + ground files initialized + bindings/cache seeded +
 *      pre-commit hook installed.
 *   2. Idempotent re-run is a no-op.
 *   3. Dry-run reports without writing.
 *   4. Non-cairn repo refused with exit 2.
 *   5. Foreign pre-commit hook backed up + replaced (item 7).
 *   6. Matching pre-commit template is a true no-op.
 *   7. Realistic fixture (12 standard + 5 edge-case DECs + 6 INVs:
 *      CRLF, empty body, special chars in title, ~12kb body,
 *      partially-stamped) migrates cleanly + idempotently (item 8).
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
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT_PATH = "/tmp/cairn-v0.5.0-migrate.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-migrate-"));
  cleanups.push(dir);
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/**
 * v0.4.x-shape DEC: no `sot_kind` / `sot_path` / `sot_content_hash`
 * fields. Migration script must add them.
 */
function v04Dec(id: string, title: string, body: string): string {
  return [
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
    "capture_source: init-source-comments",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function v04Inv(id: string, title: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: invariant",
    "status: active",
    "audience: dual",
    "generated: 2026-01-01T00:00:00Z",
    "verified-at: 2026-01-01T00:00:00Z",
    "capture_source: smoke",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function runScript(repoRoot: string, extraArgs: string[] = []): string {
  return execFileSync("node", [SCRIPT_PATH, "--repo", repoRoot, ...extraArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main(): Promise<void> {
  console.log("smoke-migrate-to-sot — start");

  if (!existsSync(SCRIPT_PATH)) {
    console.error(
      `✗ migration script missing at ${SCRIPT_PATH} — re-run block 11 to recreate it`,
    );
    process.exit(1);
  }

  // ── Step 1 — Synthesize v0.4.x repo + run migration ─────────────
  {
    const repoRoot = mkRepoRoot();
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    mkdirSync(join(repoRoot, ".cairn", "ground", "invariants"), { recursive: true });
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-aaaaaaa.md",
      v04Dec("DEC-aaaaaaa", "Postgres pin", "Pin Postgres at 15. Legacy ETL needs replication-slot semantics."),
    );
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-bbbbbbb.md",
      v04Dec("DEC-bbbbbbb", "JWT signing", "Sign tokens with HS512 because rotation infra is absent."),
    );
    writeFile(
      repoRoot,
      ".cairn/ground/invariants/INV-1111111.md",
      v04Inv("INV-1111111", "Auth token TTL", "All bearer tokens MUST expire within 24h."),
    );

    runScript(repoRoot);

    // Step 1 — sot_* fields stamped on every entity.
    const decA = readFileSync(join(repoRoot, ".cairn/ground/decisions/DEC-aaaaaaa.md"), "utf8");
    assert(decA.includes("sot_kind: ledger"), "Step 1: DEC sot_kind stamped");
    assert(decA.includes("sot_path: ledger"), "Step 1: DEC sot_path stamped");
    assert(/sot_content_hash: [a-f0-9]{64}/.test(decA), "Step 1: DEC sot_content_hash stamped");
    const invA = readFileSync(join(repoRoot, ".cairn/ground/invariants/INV-1111111.md"), "utf8");
    assert(invA.includes("sot_kind: ledger"), "Step 1: INV sot_kind stamped");
    assert(/sot_content_hash: [a-f0-9]{64}/.test(invA), "Step 1: INV sot_content_hash stamped");

    // Step 2 — ground-state files exist + non-empty (with header).
    for (const rel of ["topic-index.yaml", "sot-bindings.yaml", "sot-cache.yaml", "anchor-map.yaml"]) {
      const abs = join(repoRoot, ".cairn/ground", rel);
      assert(existsSync(abs), `Step 1: ${rel} created`);
      const body = readFileSync(abs, "utf8");
      assert(body.includes("version: 1"), `Step 1: ${rel} carries version header`);
    }

    // Step 3 — bindings + cache seeded from the 3 entities.
    const bindings = readFileSync(join(repoRoot, ".cairn/ground/sot-bindings.yaml"), "utf8");
    assert(bindings.includes("DEC-aaaaaaa: ledger"), "Step 1: bindings.forward stamps DEC-aaaaaaa");
    assert(bindings.includes("DEC-bbbbbbb: ledger"), "Step 1: bindings.forward stamps DEC-bbbbbbb");
    assert(bindings.includes("INV-1111111: ledger"), "Step 1: bindings.forward stamps INV-1111111");
    const cache = readFileSync(join(repoRoot, ".cairn/ground/sot-cache.yaml"), "utf8");
    assert(cache.includes("DEC-aaaaaaa:"), "Step 1: cache stamps DEC-aaaaaaa");
    assert(cache.includes("INV-1111111:"), "Step 1: cache stamps INV-1111111");

    // Step 4 — pre-commit hook installed.
    const hookPath = join(repoRoot, ".cairn/git-hooks/pre-commit");
    assert(existsSync(hookPath), "Step 1: pre-commit hook installed");
    const hookBody = readFileSync(hookPath, "utf8");
    assert(hookBody.includes("hook pre-commit-align"), "Step 1: pre-commit invokes Layer B alignment");

    console.log("  ✓ Step 1 — Migration backfilled, ground files created, bindings + cache seeded, pre-commit installed");
  }

  // ── Step 2 — Idempotent re-run ──────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-ccccccc.md",
      v04Dec("DEC-ccccccc", "Idempotent test", "Body for idempotency check."),
    );
    runScript(repoRoot);
    const firstDec = readFileSync(join(repoRoot, ".cairn/ground/decisions/DEC-ccccccc.md"), "utf8");
    runScript(repoRoot);
    const secondDec = readFileSync(join(repoRoot, ".cairn/ground/decisions/DEC-ccccccc.md"), "utf8");
    assert(firstDec === secondDec, "Step 2: idempotent re-run produces identical entity files");
    console.log("  ✓ Step 2 — Idempotent re-run is a no-op");
  }

  // ── Step 3 — Dry-run leaves files untouched ─────────────────────
  {
    const repoRoot = mkRepoRoot();
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-ddddddd.md",
      v04Dec("DEC-ddddddd", "Dry test", "Body for dry-run."),
    );
    const before = readFileSync(join(repoRoot, ".cairn/ground/decisions/DEC-ddddddd.md"), "utf8");
    runScript(repoRoot, ["--dry-run"]);
    const after = readFileSync(join(repoRoot, ".cairn/ground/decisions/DEC-ddddddd.md"), "utf8");
    assert(after === before, "Step 3: dry-run leaves entity unchanged");
    assert(
      !existsSync(join(repoRoot, ".cairn/ground/sot-bindings.yaml")),
      "Step 3: dry-run does not write bindings",
    );
    assert(
      !existsSync(join(repoRoot, ".cairn/git-hooks/pre-commit")),
      "Step 3: dry-run does not install hook",
    );
    console.log("  ✓ Step 3 — Dry-run reports without writing");
  }

  // ── Step 4 — Refuses non-cairn repo ─────────────────────────────
  {
    const tmpDir = mkdtempSync(join(tmpdir(), "cairn-smoke-no-cairn-"));
    cleanups.push(tmpDir);
    let exitCode = 0;
    try {
      runScript(tmpDir);
    } catch (err) {
      const e = err as { status?: number };
      exitCode = e.status ?? 1;
    }
    assert(exitCode === 2, `Step 4: expected exit 2 for non-cairn repo, got ${exitCode}`);
    console.log("  ✓ Step 4 — Non-cairn repo refused with exit 2");
  }

  // ── Step 5 — Foreign pre-commit hook backed up + replaced ───────
  {
    const repoRoot = mkRepoRoot();
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-eeeeeee.md",
      v04Dec("DEC-eeeeeee", "Foreign hook test", "Body for foreign hook check."),
    );
    const foreign = "#!/usr/bin/env bash\n# operator's prior tool\necho 'old hook ran'\n";
    writeFile(repoRoot, ".cairn/git-hooks/pre-commit", foreign);

    const out = runScript(repoRoot);
    assert(
      out.includes("foreign hook detected"),
      `Step 5: stdout warns about foreign hook, got:\n${out}`,
    );
    const backupPath = join(repoRoot, ".cairn/git-hooks/pre-commit.pre-v0.5.0.bak");
    assert(existsSync(backupPath), "Step 5: backup file written");
    assert(
      readFileSync(backupPath, "utf8") === foreign,
      "Step 5: backup carries the original hook content",
    );
    const installed = readFileSync(join(repoRoot, ".cairn/git-hooks/pre-commit"), "utf8");
    assert(
      installed.includes("hook pre-commit-align"),
      "Step 5: Cairn template overwrites the foreign hook",
    );
    console.log("  ✓ Step 5 — Foreign pre-commit hook backed up + replaced");
  }

  // ── Step 6 — Matching template is no-op (no spurious backup) ────
  {
    const repoRoot = mkRepoRoot();
    mkdirSync(join(repoRoot, ".cairn", "ground", "decisions"), { recursive: true });
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-fffffff.md",
      v04Dec("DEC-fffffff", "Matching hook test", "Body for matching-hook check."),
    );
    runScript(repoRoot);
    // Capture the installed template for the second run.
    const hookPath = join(repoRoot, ".cairn/git-hooks/pre-commit");
    const firstHook = readFileSync(hookPath, "utf8");
    const out2 = runScript(repoRoot);
    assert(
      out2.includes("already present"),
      `Step 6: matching hook reports already-present, got:\n${out2}`,
    );
    assert(
      readFileSync(hookPath, "utf8") === firstHook,
      "Step 6: matching hook left untouched on re-run",
    );
    assert(
      !existsSync(`${hookPath}.pre-v0.5.0.bak`),
      "Step 6: no backup created when hashes match",
    );
    console.log("  ✓ Step 6 — Matching pre-commit template is a true no-op");
  }

  // ── Step 7 — Realistic v0.4.x fixture with edge cases ───────────
  {
    const repoRoot = mkRepoRoot();
    const decDir = join(repoRoot, ".cairn", "ground", "decisions");
    const invDir = join(repoRoot, ".cairn", "ground", "invariants");
    mkdirSync(decDir, { recursive: true });
    mkdirSync(invDir, { recursive: true });
    // 12 standard DECs + 6 standard INVs.
    for (let i = 0; i < 12; i++) {
      const id = `DEC-${"0123456789abcdef"[i]}123456`;
      writeFile(
        repoRoot,
        `.cairn/ground/decisions/${id}.md`,
        v04Dec(id, `Standard fixture ${i}`, `Body ${i}: token quota policy ${i}.`),
      );
    }
    for (let i = 0; i < 6; i++) {
      const id = `INV-${"0123456789abcdef"[i]}123456`;
      writeFile(
        repoRoot,
        `.cairn/ground/invariants/${id}.md`,
        v04Inv(id, `Standard invariant ${i}`, `Constraint ${i} for invariant fixture.`),
      );
    }
    // Edge: CRLF line endings.
    const crlfBody = v04Dec(
      "DEC-c5c5c5c",
      "CRLF body",
      "First line.\nSecond line.\nThird line.",
    ).replace(/\n/g, "\r\n");
    writeFile(repoRoot, ".cairn/ground/decisions/DEC-c5c5c5c.md", crlfBody);
    // Edge: empty body (no prose between the closing --- and EOF).
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-eeeeee0.md",
      [
        "---",
        "id: DEC-eeeeee0",
        "title: Empty body",
        "type: adr",
        "status: accepted",
        "audience: dual",
        "generated: 2026-01-01T00:00:00Z",
        "verified-at: 2026-01-01T00:00:00Z",
        "decided_at: 2026-01-01T00:00:00Z",
        "decided_by: smoke",
        "capture_source: smoke",
        "---",
        "",
      ].join("\n"),
    );
    // Edge: special chars in title (colons + quotes).
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-5cec1a1.md",
      v04Dec(
        "DEC-5cec1a1",
        '"Pin": Postgres at v15 — operator prefers ETL stability.',
        "Title carries colon, dash, quotes, and unicode em dash.",
      ),
    );
    // Edge: very long body (~12kb).
    const longBody = "Long-body line, repeated for compression test.\n".repeat(250);
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-10ng000.md",
      v04Dec("DEC-10ng000", "Long body", longBody),
    );
    // Edge: partially stamped (sot_kind set, sot_path missing) — migration
    // must still backfill the missing fields.
    writeFile(
      repoRoot,
      ".cairn/ground/decisions/DEC-9a9f111.md",
      [
        "---",
        "id: DEC-9a9f111",
        "title: Partial stamp",
        "type: adr",
        "status: accepted",
        "audience: dual",
        "generated: 2026-01-01T00:00:00Z",
        "verified-at: 2026-01-01T00:00:00Z",
        "decided_at: 2026-01-01T00:00:00Z",
        "decided_by: smoke",
        "sot_kind: ledger",
        "capture_source: smoke",
        "---",
        "",
        "Body for the partially-stamped fixture.",
        "",
      ].join("\n"),
    );

    runScript(repoRoot);

    // Every entity must end up fully stamped.
    const decFiles = [
      ...["DEC-0123456","DEC-1123456","DEC-2123456","DEC-3123456","DEC-4123456","DEC-5123456","DEC-6123456","DEC-7123456","DEC-8123456","DEC-9123456","DEC-a123456","DEC-b123456"],
      "DEC-c5c5c5c",
      "DEC-eeeeee0",
      "DEC-5cec1a1",
      "DEC-10ng000",
      "DEC-9a9f111",
    ];
    for (const id of decFiles) {
      const body = readFileSync(join(repoRoot, ".cairn/ground/decisions", `${id}.md`), "utf8");
      assert(
        body.includes("sot_kind: ledger"),
        `Step 7: ${id} sot_kind stamped`,
      );
      assert(
        body.includes("sot_path: ledger"),
        `Step 7: ${id} sot_path stamped`,
      );
      assert(
        /sot_content_hash: [a-f0-9]{64}/.test(body) ||
          /sot_content_hash: '[a-f0-9]{64}'/.test(body) ||
          /sot_content_hash: "[a-f0-9]{64}"/.test(body),
        `Step 7: ${id} sot_content_hash stamped, got:\n${body.slice(0, 500)}`,
      );
    }
    const invFiles = [
      "INV-0123456","INV-1123456","INV-2123456","INV-3123456","INV-4123456","INV-5123456",
    ];
    for (const id of invFiles) {
      const body = readFileSync(join(repoRoot, ".cairn/ground/invariants", `${id}.md`), "utf8");
      assert(body.includes("sot_kind: ledger"), `Step 7: ${id} sot_kind stamped`);
      assert(body.includes("sot_path: ledger"), `Step 7: ${id} sot_path stamped`);
    }

    // Re-run is idempotent across the realistic fixture.
    const snapshot = decFiles
      .map((id) => readFileSync(join(repoRoot, ".cairn/ground/decisions", `${id}.md`), "utf8"))
      .join("\n--ENT--\n");
    runScript(repoRoot);
    const after = decFiles
      .map((id) => readFileSync(join(repoRoot, ".cairn/ground/decisions", `${id}.md`), "utf8"))
      .join("\n--ENT--\n");
    assert(snapshot === after, "Step 7: idempotent across realistic fixture");

    // Bindings + cache cover every entity (12 + 1 CRLF + 1 empty + 1 special + 1 long + 1 partial = 17 DECs + 6 INVs = 23 entries).
    const bindings = readFileSync(join(repoRoot, ".cairn/ground/sot-bindings.yaml"), "utf8");
    for (const id of decFiles) {
      assert(bindings.includes(`${id}: ledger`), `Step 7: bindings stamps ${id}`);
    }
    for (const id of invFiles) {
      assert(bindings.includes(`${id}: ledger`), `Step 7: bindings stamps ${id}`);
    }
    console.log(`  ✓ Step 7 — Realistic fixture (${decFiles.length} DECs + ${invFiles.length} INVs, CRLF + empty + special + long + partial-stamp) migrates cleanly + idempotently`);
  }

  cleanup();
  console.log("smoke-migrate-to-sot — OK");
}

main().catch((err) => {
  console.error("smoke-migrate-to-sot — fail:", err);
  cleanup();
  process.exit(1);
});
