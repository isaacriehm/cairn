#!/usr/bin/env tsx
/**
 * smoke-migrate-doc-repairs — the 0.26.0 content-repair migrations.
 *
 *   0005-demote-autofilled-brand     — auto-generated brand marked confirmed
 *                                       → demoted to draft (operator brand kept)
 *   0006-prune-sot-align-invariants  — junk Layer-A invariants archived
 *   0007-collapse-component-dirs     — redundant nested componentDirs collapsed
 *
 * Each migration is exercised via its own detect()/apply() (version-
 * independent: the runner only selects them once VERSION ≥ 0.26.0).
 * Fixtures use neutral placeholder names only.
 */

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
import { dirname, join } from "node:path";
import { MIGRATIONS, bodyContentHash } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function mkRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-smoke-migrepair-${tag}-`));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function migration(id: string) {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (m === undefined) {
    console.error(`✗ migration ${id} not registered`);
    cleanup();
    process.exit(1);
  }
  return m;
}

// Exact markers the 0005 migration keys off (pre-0.25.0 mechanical fallback).
const VOICE_FALLBACK =
  "Direct, technical, project-aware. Match the existing tone in CLAUDE.md / AGENTS.md if those files set a register; otherwise default to short sentences.";
const PERSONA_FALLBACK =
  "Developers and operators working on this project. Refine when adding consumer-facing or external personas.";

function main(): void {
  console.log("smoke-migrate-doc-repairs — start");

  // ── 0005 — demote auto-generated brand, keep operator brand ─────────
  {
    const m = migration("0005-demote-autofilled-brand");

    const repo = mkRepo("brand");
    // Mechanical-fallback voice → auto.
    write(repo, ".cairn/ground/brand/voice.md", `---\nstatus: current\n---\n\n# Voice\n\n${VOICE_FALLBACK}\n`);
    // overview === positioning (auto-fill wrote the same summary to both).
    const dup = "This product does a specific thing for a specific audience.";
    write(repo, ".cairn/ground/brand/overview.md", `---\nstatus: current\n---\n\n# Overview\n\n${dup}\n`);
    write(repo, ".cairn/ground/product/positioning.md", `---\nstatus: current\n---\n\n# Positioning\n\n${dup}\n`);
    // Placeholder personas → auto.
    write(repo, ".cairn/ground/product/personas.yaml", `status: current\npersonas:\n  - name: primary\n    description: ${PERSONA_FALLBACK}\n`);

    assert(m.detect(repo), "0005: should detect auto-generated confirmed brand");
    const r = m.apply(repo);
    assert(r.changed, "0005: apply should change something");
    for (const f of ["brand/voice.md", "brand/overview.md", "product/positioning.md", "product/personas.yaml"]) {
      const t = readFileSync(join(repo, ".cairn/ground", f), "utf8");
      assert(/status:\s*draft/.test(t), `0005: ${f} should be demoted to draft`);
      assert(!/status:\s*current/.test(t), `0005: ${f} should no longer be current`);
    }
    assert(!m.detect(repo), "0005: re-detect is a no-op after demotion");
    assert(!m.apply(repo).changed, "0005: re-apply is idempotent");

    // Control: operator-written brand (no marker, divergent pair) is untouched.
    const repo2 = mkRepo("brand-real");
    write(repo2, ".cairn/ground/brand/voice.md", `---\nstatus: current\n---\n\n# Voice\n\nWe write like a pirate. Arrr.\n`);
    write(repo2, ".cairn/ground/brand/overview.md", `---\nstatus: current\n---\n\n# Overview\n\nA pirate-themed treasure tracker.\n`);
    write(repo2, ".cairn/ground/product/positioning.md", `---\nstatus: current\n---\n\n# Positioning\n\nFor swashbucklers managing loot.\n`);
    assert(!m.detect(repo2), "0005: operator-written brand must NOT be flagged");
    console.log("  ✓ 0005 — auto-generated brand demoted; operator brand untouched");
  }

  // ── 0006 — archive junk sot-align invariants, keep the real ones ────
  {
    const m = migration("0006-prune-sot-align-invariants");
    const repo = mkRepo("inv");
    const invDir = ".cairn/ground/invariants";
    const seedInv = (id: string, title: string, body: string, source: string): void => {
      write(
        repo,
        `${invDir}/${id}.md`,
        [
          "---",
          `id: ${id}`,
          `title: ${title}`,
          "type: invariant",
          "status: active",
          "audience: dual",
          "sot_kind: ledger",
          "sot_path: ledger",
          `sot_content_hash: ${bodyContentHash(body)}`,
          `capture_source: ${source}`,
          "---",
          "",
          body,
          "",
        ].join("\n"),
      );
    };
    seedInv("INV-aaaaaa1", "Section divider", "────────────────────", "layer-a-sot-align"); // junk
    seedInv("INV-bbbbbb1", "Token expiry", "Tokens MUST expire after 15 minutes.", "layer-a-sot-align"); // real
    seedInv("INV-cccccc1", "Curated", "A curated entry with no modal verb.", "init-source-comments"); // out of scope

    assert(m.detect(repo), "0006: should detect a junk sot-align invariant");
    const r = m.apply(repo);
    assert(r.changed, "0006: apply should archive the junk one");
    const active = readdirSync(join(repo, invDir)).filter((n) => n.endsWith(".md"));
    assert(!active.includes("INV-aaaaaa1.md"), "0006: junk invariant archived out of the active dir");
    assert(active.includes("INV-bbbbbb1.md"), "0006: real sot-align invariant kept");
    assert(active.includes("INV-cccccc1.md"), "0006: curated invariant never touched");
    assert(
      existsSync(join(repo, ".cairn/ground/.archive/invariants/INV-aaaaaa1.md")),
      "0006: junk invariant lands in .archive",
    );
    assert(!m.detect(repo), "0006: re-detect is a no-op after prune");
    console.log("  ✓ 0006 — junk sot-align invariant archived; real + curated kept");
  }

  // ── 0007 — collapse redundant nested componentDirs ──────────────────
  {
    const m = migration("0007-collapse-component-dirs");
    const repo = mkRepo("dirs");
    write(
      repo,
      ".cairn/config.yaml",
      [
        "version: 1",
        "cairn_version: 0.22.6",
        "slug: smoke",
        "components:",
        "  workspaces:",
        "    app:",
        "      componentDirs:",
        "        - src/components",
        "        - src/components/forms",
        "        - src/components/forms/inputs",
        "        - src/widgets",
        "        - src/widgets/button",
        "      extensions:",
        "        - .tsx",
        "      categories:",
        "        - forms",
        "",
      ].join("\n"),
    );
    assert(m.detect(repo), "0007: should detect redundant nested componentDirs");
    const r = m.apply(repo);
    assert(r.changed, "0007: apply should collapse the list");
    const cfg = readFileSync(join(repo, ".cairn/config.yaml"), "utf8");
    assert(cfg.includes("src/components"), "0007: shallowest ancestor kept (src/components)");
    assert(cfg.includes("src/widgets"), "0007: shallowest ancestor kept (src/widgets)");
    assert(!cfg.includes("forms/inputs"), "0007: deep descendant removed");
    assert(!cfg.includes("widgets/button"), "0007: leaf component dir removed");
    assert(!cfg.includes("components/forms"), "0007: nested child removed");
    // Sibling config keys survive.
    assert(cfg.includes("categories:") && cfg.includes("- forms"), "0007: sibling keys preserved");
    assert(cfg.includes("slug: smoke"), "0007: unrelated top-level keys preserved");
    assert(!m.detect(repo), "0007: re-detect is a no-op after collapse");
    assert(!m.apply(repo).changed, "0007: re-apply is idempotent");

    // Control: non-overlapping dirs → nothing to do.
    const repo2 = mkRepo("dirs-clean");
    write(
      repo2,
      ".cairn/config.yaml",
      ["version: 1", "slug: smoke", "components:", "  workspaces:", "    app:", "      componentDirs:", "        - src/components", "        - src/widgets", "      extensions:", "        - .tsx", ""].join("\n"),
    );
    assert(!m.detect(repo2), "0007: a clean componentDirs list is not flagged");
    console.log("  ✓ 0007 — redundant nested componentDirs collapsed; clean lists untouched");
  }

  cleanup();
  console.log("smoke-migrate-doc-repairs — pass");
}

main();
