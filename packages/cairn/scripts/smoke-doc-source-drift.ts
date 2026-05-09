#!/usr/bin/env tsx
/**
 * smoke-doc-source-drift — GC pass 11 acceptance.
 *
 * Synthetic .cairn/ground/ with one ledger DEC, one path DEC pinned to a
 * markdown section, one path DEC whose source is missing, one path INV
 * with a stale anchor, and one DEC whose body has drifted out from
 * under it. The pass should:
 *
 *   1. Skip ledger-kind entries entirely.
 *   2. Stay silent when sot_path file content matches the snapshot hash.
 *   3. Emit `doc_source_drift` when section body changes.
 *   4. Emit `sot_missing` when sot_path file no longer exists.
 *   5. Emit `sot_anchor_missing` when anchor heading has been renamed.
 *   6. Walk DECs and INVs both.
 *   7. Be wired into runGcSweep.
 *
 * Mechanical — no LLM calls, no quota.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bodyContentHash,
  extractSectionByAnchor,
  runDocSourceDrift,
  runGcSweep,
  slugifyHeading,
} from "@isaacriehm/cairn-core";
import type { GcFinding } from "@isaacriehm/cairn-core";

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

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-doc-source-drift-"));
  cleanups.push(root);
  mkdirSync(resolve(root, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(resolve(root, ".cairn", "ground", "invariants"), { recursive: true });
  mkdirSync(resolve(root, "docs"), { recursive: true });
  return root;
}

function writeDoc(root: string, rel: string, body: string): void {
  writeFileSync(resolve(root, rel), body, "utf8");
}

function writeDec(
  root: string,
  id: string,
  fm: Record<string, string>,
  body: string,
): void {
  const fmYaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const out = `---\n${fmYaml}\n---\n\n${body}\n`;
  writeFileSync(resolve(root, ".cairn", "ground", "decisions", `${id}.md`), out, "utf8");
}

function writeInv(
  root: string,
  id: string,
  fm: Record<string, string>,
  body: string,
): void {
  const fmYaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const out = `---\n${fmYaml}\n---\n\n${body}\n`;
  writeFileSync(resolve(root, ".cairn", "ground", "invariants", `${id}.md`), out, "utf8");
}

async function main(): Promise<void> {
  console.log("smoke-doc-source-drift — start");

  header("Step 1 — slugifyHeading + extractSectionByAnchor primitives");
  {
    if (slugifyHeading("Brand Voice") !== "brand-voice") fail("slug: 'Brand Voice'");
    if (slugifyHeading("§3 Token Policy!") !== "3-token-policy") fail(`slug: §3 Token Policy got '${slugifyHeading("§3 Token Policy!")}'`);
    const md = "# Top\n\n## Section A\nbody A\n\n## Section B\nbody B\n";
    const a = extractSectionByAnchor(md, "section-a");
    if (a !== "## Section A\nbody A") fail(`extracted A: ${JSON.stringify(a)}`);
    const b = extractSectionByAnchor(md, "section-b");
    if (b !== "## Section B\nbody B") fail(`extracted B: ${JSON.stringify(b)}`);
    if (extractSectionByAnchor(md, "missing") !== null) fail("missing anchor should return null");
    pass("slugifyHeading + extractSectionByAnchor work");
  }

  const repo = makeRepo();

  header("Step 2 — ledger-kind DECs are ignored");
  {
    writeDec(
      repo,
      "DEC-1234567",
      {
        id: "DEC-1234567",
        title: "Ledger DEC",
        status: "accepted",
        sot_kind: "ledger",
        sot_path: "ledger",
        sot_content_hash: "0".repeat(64),
      },
      "Some ledger body.",
    );
    const r = runDocSourceDrift({ repoRoot: repo });
    if (r.scanned !== 0) fail(`expected 0 scanned, got ${r.scanned}`);
    if (r.findings.length !== 0) fail(`expected 0 findings, got ${r.findings.length}`);
    pass("ledger-kind not scanned");
  }

  header("Step 3 — path-kind DEC matching snapshot is silent");
  {
    const sectionBody = "## Brand Voice\nThe operator-facing voice is terse-direct.";
    writeDoc(repo, "docs/brand.md", `# Brand\n\n${sectionBody}\n\n## Other\nUnrelated.\n`);
    writeDec(
      repo,
      "DEC-aaaaaaa",
      {
        id: "DEC-aaaaaaa",
        title: "Brand voice",
        status: "accepted",
        sot_kind: "path",
        sot_path: "docs/brand.md#brand-voice",
        sot_content_hash: bodyContentHash(sectionBody),
      },
      sectionBody,
    );
    const r = runDocSourceDrift({ repoRoot: repo });
    if (r.scanned !== 1) fail(`expected 1 scanned, got ${r.scanned}`);
    if (r.findings.length !== 0) {
      console.error(JSON.stringify(r.findings, null, 2));
      fail("clean snapshot should produce 0 findings");
    }
    pass("snapshot-matching path DEC is silent");
  }

  header("Step 4 — drift in section body produces doc_source_drift");
  {
    writeDoc(
      repo,
      "docs/brand.md",
      "# Brand\n\n## Brand Voice\nThe operator-facing voice is now formal-corporate.\n\n## Other\nUnrelated.\n",
    );
    const r = runDocSourceDrift({ repoRoot: repo });
    const drift = findOf(r.findings, "doc_source_drift");
    if (drift === null) fail("expected doc_source_drift finding");
    if (!drift.detail.includes("DEC-aaaaaaa.md")) fail("finding path missing DEC id");
    pass("section-body edit surfaces drift");
  }

  header("Step 5 — sot_path file removed → sot_missing");
  {
    rmSync(resolve(repo, "docs/brand.md"));
    const r = runDocSourceDrift({ repoRoot: repo });
    const missing = findOf(r.findings, "sot_missing");
    if (missing === null) fail("expected sot_missing finding");
    if (!missing.detail.includes("docs/brand.md")) fail("missing detail should name file");
    pass("missing sot file → sot_missing");
  }

  header("Step 6 — anchor renamed → sot_anchor_missing");
  {
    writeDoc(
      repo,
      "docs/brand.md",
      "# Brand\n\n## Brand Tone\nOperator-facing.\n\n## Other\nUnrelated.\n",
    );
    const r = runDocSourceDrift({ repoRoot: repo });
    const anchor = findOf(r.findings, "sot_anchor_missing");
    if (anchor === null) fail("expected sot_anchor_missing finding");
    pass("renamed anchor → sot_anchor_missing");
  }

  header("Step 7 — INVs are walked too");
  {
    const invBody = "## Pin\nThe sensor pin is enforced.";
    writeDoc(repo, "docs/sensors.md", `# Sensors\n\n${invBody}\n`);
    writeInv(
      repo,
      "INV-bbbbbbb",
      {
        id: "INV-bbbbbbb",
        title: "Sensor pin",
        status: "active",
        sot_kind: "path",
        sot_path: "docs/sensors.md#pin",
        sot_content_hash: bodyContentHash(invBody),
      },
      invBody,
    );
    const r = runDocSourceDrift({ repoRoot: repo });
    if (r.scanned < 2) fail(`expected ≥2 scanned (DEC + INV), got ${r.scanned}`);
    pass(`scanned ${r.scanned} path-kind entries`);
  }

  header("Step 8 — runGcSweep wires the pass through");
  {
    const sweep = await runGcSweep({ repoRoot: repo });
    if (sweep.pass_durations["doc-source-drift"] === undefined) {
      fail("sweep did not record doc-source-drift pass");
    }
    const driftFindings = sweep.findings.filter((f) => f.pass === "doc-source-drift");
    if (driftFindings.length === 0) fail("sweep should surface drift findings");
    pass(`sweep wired; ${driftFindings.length} doc-source-drift findings`);
  }

  console.log("smoke-doc-source-drift — pass");
}

function findOf(findings: GcFinding[], kind: string): GcFinding | null {
  return findings.find((f) => f.kind === kind) ?? null;
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
