#!/usr/bin/env tsx
/**
 * smoke-migrate-doc-repairs — the 0.26.0 content-repair migrations.
 *
 *   0005-demote-autofilled-brand     — auto-generated brand marked confirmed
 *                                       → demoted to draft (operator brand kept)
 *   0006-prune-sot-align-invariants  — junk Layer-A invariants archived
 *   0007-collapse-component-dirs     — redundant nested componentDirs collapsed
 *   0008-clean-adoption-scaffolding  — leaked internal-doc refs / jargon /
 *                                       placeholder comments scrubbed +
 *                                       synthetic timestamps → real git add-date
 *
 * Each migration is exercised via its own detect()/apply() (version-
 * independent: the runner only selects them once VERSION ≥ the ship line).
 * Fixtures use neutral placeholder names only.
 */

import { execFileSync } from "node:child_process";
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

/** Init a git repo + commit everything — gives tracked files a real add-date. */
function gitCommitAll(repo: string, msg: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
  };
  git("init", "-q");
  git("config", "user.email", "smoke@cairn.test");
  git("config", "user.name", "cairn-smoke");
  git("add", "-A");
  git("commit", "-q", "-m", msg);
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

    // Co-generation cohort: Haiku-derived voice/personas carry NO marker but
    // share the auto-filled pair's `generated` stamp → demoted via channel 2.
    // (This is the case the 0.26.0 marker-only detection missed.)
    const T = "2026-05-04T00:00:00Z";
    const repoC = mkRepo("brand-cohort");
    const same = "A freshly-worded but machine-written domain summary.";
    write(repoC, ".cairn/ground/brand/overview.md", `---\nstatus: current\ngenerated: ${T}\n---\n\n# Overview\n\n${same}\n`);
    write(repoC, ".cairn/ground/product/positioning.md", `---\nstatus: current\ngenerated: ${T}\n---\n\n# Positioning\n\n${same}\n`);
    write(repoC, ".cairn/ground/brand/voice.md", `---\nstatus: current\ngenerated: ${T}\n---\n\n# Voice\n\nCrisp and specific. No fixed marker string here.\n`);
    write(repoC, ".cairn/ground/product/personas.yaml", `status: current\ngenerated: ${T}\npersonas:\n  - name: primary\n    description: A specific real user, no placeholder marker.\n`);
    assert(m.detect(repoC), "0005: should detect a markerless co-generated cohort");
    assert(m.apply(repoC).changed, "0005: cohort apply should demote");
    for (const f of ["brand/voice.md", "brand/overview.md", "product/positioning.md", "product/personas.yaml"]) {
      const t = readFileSync(join(repoC, ".cairn/ground", f), "utf8");
      assert(/status:\s*draft/.test(t), `0005: cohort ${f} should be demoted (markerless)`);
    }

    // Timestamp guard: an operator who hand-wrote voice.md LATER (different
    // `generated`) keeps it confirmed even though the pair is auto-filled.
    const repoG = mkRepo("brand-guard");
    write(repoG, ".cairn/ground/brand/overview.md", `---\nstatus: current\ngenerated: ${T}\n---\n\n# Overview\n\n${same}\n`);
    write(repoG, ".cairn/ground/product/positioning.md", `---\nstatus: current\ngenerated: ${T}\n---\n\n# Positioning\n\n${same}\n`);
    write(repoG, ".cairn/ground/brand/voice.md", `---\nstatus: current\ngenerated: 2026-09-01T12:00:00Z\n---\n\n# Voice\n\nHand-tuned voice the operator wrote a month later.\n`);
    assert(m.detect(repoG), "0005: guard repo still detects the auto-filled pair");
    m.apply(repoG);
    const guardVoice = readFileSync(join(repoG, ".cairn/ground/brand/voice.md"), "utf8");
    assert(/status:\s*current/.test(guardVoice), "0005: later-stamped hand-written voice is spared");
    const guardOverview = readFileSync(join(repoG, ".cairn/ground/brand/overview.md"), "utf8");
    assert(/status:\s*draft/.test(guardOverview), "0005: the auto-filled pair is still demoted");

    // Control: operator-written brand (no marker, divergent pair) is untouched.
    const repo2 = mkRepo("brand-real");
    write(repo2, ".cairn/ground/brand/voice.md", `---\nstatus: current\n---\n\n# Voice\n\nWe write like a pirate. Arrr.\n`);
    write(repo2, ".cairn/ground/brand/overview.md", `---\nstatus: current\n---\n\n# Overview\n\nA pirate-themed treasure tracker.\n`);
    write(repo2, ".cairn/ground/product/positioning.md", `---\nstatus: current\n---\n\n# Positioning\n\nFor swashbucklers managing loot.\n`);
    assert(!m.detect(repo2), "0005: operator-written brand must NOT be flagged");
    console.log("  ✓ 0005 — auto-generated brand (incl. markerless cohort) demoted; timestamp-guarded + operator brand kept");
  }

  // ── 0006 — archive junk sot-align invariants, keep the real ones ────
  {
    const m = migration("0006-prune-sot-align-invariants");
    const repo = mkRepo("inv");
    const invDir = ".cairn/ground/invariants";
    const seedInv = (
      id: string,
      title: string,
      body: string,
      source: string,
      sourceFile = "src/core/thing.ts",
    ): void => {
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
          `source_file: ${sourceFile}`,
          "---",
          "",
          body,
          "",
        ].join("\n"),
      );
    };
    // junk: separator/non-lexical title (capture artifact)
    seedInv("INV-aaaaaa1", "────────────────────", "── Conference / Recording ──", "layer-a-sot-align");
    // junk: modal buried below the statement (title + lead lines are descriptive)
    seedInv(
      "INV-aaaaaa2",
      "AiService writes one row per call session.",
      "AiService writes one row per call session.\nIt batches inserts for throughput.\nOn a failed write it must roll back the batch.",
      "layer-a-sot-align",
    );
    // junk: captured from a test file (modal in statement, but it's a spec note)
    seedInv(
      "INV-aaaaaa3",
      "Rollback contract on inbound write",
      "The whole inbound write MUST roll back on a throw.",
      "layer-a-sot-align",
      "core/src/sms/sms-inbound.integration.spec.ts",
    );
    // real: the rule sits in the statement, sourced from production code
    seedInv("INV-bbbbbb1", "Token expiry", "Tokens MUST expire after 15 minutes.", "layer-a-sot-align");
    // out of scope: curated capture_source is never touched, modal or not
    seedInv("INV-cccccc1", "Curated", "A curated entry with no modal verb.", "init-source-comments");

    assert(m.detect(repo), "0006: should detect junk sot-align invariants");
    const r = m.apply(repo);
    assert(r.changed, "0006: apply should archive the junk ones");
    const active = readdirSync(join(repo, invDir)).filter((n) => n.endsWith(".md"));
    assert(!active.includes("INV-aaaaaa1.md"), "0006: separator-titled invariant archived");
    assert(!active.includes("INV-aaaaaa2.md"), "0006: buried-modal description archived (statement-scoped)");
    assert(!active.includes("INV-aaaaaa3.md"), "0006: test-file-sourced invariant archived");
    assert(active.includes("INV-bbbbbb1.md"), "0006: real sot-align invariant (rule in statement) kept");
    assert(active.includes("INV-cccccc1.md"), "0006: curated invariant never touched");
    for (const junk of ["INV-aaaaaa1", "INV-aaaaaa2", "INV-aaaaaa3"]) {
      assert(
        existsSync(join(repo, `.cairn/ground/.archive/invariants/${junk}.md`)),
        `0006: ${junk} lands in .archive (recoverable)`,
      );
    }
    assert(!m.detect(repo), "0006: re-detect is a no-op after prune");
    console.log("  ✓ 0006 — separator/buried-modal/test-sourced junk archived; real + curated kept");
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

  // ── 0008 — clean leaked adoption scaffolding (comments + timestamps) ─
  {
    const m = migration("0008-clean-adoption-scaffolding");
    const rule = "─".repeat(30);
    const SYNTH_WF = "2026-05-02T13:19:00Z";
    const SYNTH_BRAND = "2026-05-04T00:00:00Z";

    // Full fixture as a REAL git repo so the timestamp swap can resolve the
    // file's git add-date (the non-git fallback leaves the stamp untouched).
    const repo = mkRepo("scaffolding");
    write(
      repo,
      ".cairn/config/workflow.md",
      [
        "---",
        "type: workflow-policy",
        "status: draft",
        `generated: ${SYNTH_WF}`,
        `verified-at: ${SYNTH_WF}`,
        "",
        `# ${rule}`,
        "# Project-extension placeholder.",
        "#",
        "# At adoption, the init script REPLACES this block with a real key matching",
        "# the adopting project's `package.json name`.",
        `# ${rule}`,
        "",
        "smoke:",
        "  off_limits:",
        "    - .git/**",
        "",
        "---",
        "",
        "# Workflow policy",
        "",
        "Body text that should survive.",
        "",
        "If you're looking for the daily flow, see `docs/SYSTEM_OVERVIEW.md` §4.",
        "",
      ].join("\n"),
    );
    write(
      repo,
      ".cairn/config/sensors.yaml",
      [
        "version: 1",
        "sensors:",
        "  - id: stub-pattern-catalog",
        '    description: "Mechanical scan of diff against .cairn/config/stub-patterns.yaml. Layer A of the honest-agent invariants stack."',
        "",
      ].join("\n"),
    );
    write(
      repo,
      ".cairn/.gitignore",
      [
        "# Local execution record, not shared state; heavy + per-clone. Marked",
        "# GITIGNORED in docs/FILESYSTEM_LAYOUT.md.",
        "runs/",
        "",
        "# Invalidation event log — inter-session signal, 7-day retention,",
        "# regenerable. Spec: PLUGIN_ARCHITECTURE §7.",
        "events/",
        "",
        "# Per-write flock + whole-operation locks (per PLUGIN_ARCHITECTURE §7).",
        ".write-lock",
        "",
        "# Stop hook bypass detection. Per PLUGIN_ARCHITECTURE §17 Layer 1.",
        ".attested-commits",
        "",
        "# queue. Already excluded from canonical-zone reads in spec §2.2.",
        "ground/decisions/_inbox/",
        "",
      ].join("\n"),
    );
    write(
      repo,
      ".cairn/git-hooks/commit-msg",
      ["#!/usr/bin/env bash", "# Cairn commit-msg hook.", "#", "# Spec: PLUGIN_ARCHITECTURE §17 Layer 1.", "#", "# Validates citations.", "set -e", ""].join("\n"),
    );
    write(
      repo,
      ".cairn/git-hooks/post-commit",
      ["#!/usr/bin/env bash", "# Cairn post-commit hook.", "#", "# Spec: PLUGIN_ARCHITECTURE §17 Layer 1 (bypass tracking).", "#", "# Records the SHA.", "set -e", ""].join("\n"),
    );
    write(
      repo,
      ".cairn/ground/product/personas.yaml",
      ["# Product personas — who this is for. Read at every SessionStart.", "# See DOCS_SPEC.md §3.4 for shape.", "status: current", "personas:", "  - name: primary", "    description: A real user.", ""].join("\n"),
    );
    write(
      repo,
      ".cairn/ground/brand/overview.md",
      ["---", "type: rule", "status: draft", `generated: ${SYNTH_BRAND}`, `verified-at: ${SYNTH_BRAND}`, "---", "", "# Brand overview", "", "A product.", ""].join("\n"),
    );
    gitCommitAll(repo, "seed adopted .cairn");

    assert(m.detect(repo), "0008: should detect leaked scaffolding");
    assert(m.apply(repo).changed, "0008: apply should clean it");

    const wf = readFileSync(join(repo, ".cairn/config/workflow.md"), "utf8");
    assert(!wf.includes("Project-extension placeholder"), "0008: placeholder meta-comment removed");
    assert(!wf.includes("init script REPLACES"), "0008: false instruction removed");
    assert(!wf.includes("docs/SYSTEM_OVERVIEW.md"), "0008: dangling docs/ pointer removed");
    assert(wf.includes("Project workflow extension"), "0008: clean operator-facing comment present");
    assert(wf.includes("Body text that should survive."), "0008: real body preserved");
    assert(wf.includes("smoke:"), "0008: the project slug block preserved");
    assert(!wf.includes(SYNTH_WF), "0008: synthetic workflow timestamp replaced");
    assert(/verified-at: \d{4}-\d{2}-\d{2}T/.test(wf), "0008: workflow verified-at is a real ISO");

    const sensors = readFileSync(join(repo, ".cairn/config/sensors.yaml"), "utf8");
    assert(!sensors.includes("honest-agent invariants stack"), "0008: sensors.yaml jargon stripped");
    assert(sensors.includes("Mechanical scan of diff against .cairn/config/stub-patterns.yaml."), "0008: sensors.yaml mechanical description kept");

    const gi = readFileSync(join(repo, ".cairn/.gitignore"), "utf8");
    assert(!gi.includes("PLUGIN_ARCHITECTURE"), "0008: .gitignore internal-doc refs stripped");
    assert(!gi.includes("FILESYSTEM_LAYOUT"), "0008: .gitignore FILESYSTEM_LAYOUT ref stripped");
    assert(!gi.includes("spec §2.2"), "0008: .gitignore spec ref stripped");
    assert(gi.includes("runs/") && gi.includes("events/"), "0008: .gitignore entries preserved");
    assert(gi.includes("Already excluded from canonical-zone reads."), "0008: .gitignore meaning preserved");

    const cm = readFileSync(join(repo, ".cairn/git-hooks/commit-msg"), "utf8");
    assert(!cm.includes("PLUGIN_ARCHITECTURE"), "0008: commit-msg spec ref stripped");
    assert(cm.includes("Validates citations."), "0008: commit-msg body preserved");
    const pc = readFileSync(join(repo, ".cairn/git-hooks/post-commit"), "utf8");
    assert(!pc.includes("PLUGIN_ARCHITECTURE"), "0008: post-commit spec ref stripped");

    const personas = readFileSync(join(repo, ".cairn/ground/product/personas.yaml"), "utf8");
    assert(!personas.includes("DOCS_SPEC"), "0008: personas DOCS_SPEC ref stripped");
    assert(personas.includes("name: primary"), "0008: personas content preserved");

    const overview = readFileSync(join(repo, ".cairn/ground/brand/overview.md"), "utf8");
    assert(!overview.includes(SYNTH_BRAND), "0008: synthetic brand timestamp replaced");
    assert(/verified-at: \d{4}-\d{2}-\d{2}T/.test(overview), "0008: brand verified-at is a real ISO");

    assert(!m.detect(repo), "0008: re-detect is a no-op after cleanup");
    assert(!m.apply(repo).changed, "0008: re-apply is idempotent");

    // Control: a clean .cairn/ (already converged) is not flagged.
    const repo2 = mkRepo("scaffolding-clean");
    write(
      repo2,
      ".cairn/config/workflow.md",
      ["---", "type: workflow-policy", "---", "", "# Workflow policy", "", "Nothing leaked here.", ""].join("\n"),
    );
    write(
      repo2,
      ".cairn/config/sensors.yaml",
      ["version: 1", "sensors:", '  - description: "Mechanical scan."', ""].join("\n"),
    );
    assert(!m.detect(repo2), "0008: a clean .cairn/ is not flagged");

    // Non-git fallback: comment scrubs still apply, synthetic stamp LEFT
    // (never fabricated) when git can't resolve an add-date.
    const repo3 = mkRepo("scaffolding-nogit");
    write(
      repo3,
      ".cairn/config/sensors.yaml",
      ['  - description: "Scan. Layer A of the honest-agent invariants stack."', ""].join("\n"),
    );
    write(
      repo3,
      ".cairn/ground/brand/voice.md",
      ["---", "status: draft", `verified-at: ${SYNTH_BRAND}`, "---", "", "# Voice", ""].join("\n"),
    );
    assert(m.apply(repo3).changed, "0008: non-git apply still scrubs comments");
    const ng = readFileSync(join(repo3, ".cairn/config/sensors.yaml"), "utf8");
    assert(!ng.includes("honest-agent invariants stack"), "0008: comment scrub works without git");
    const ngVoice = readFileSync(join(repo3, ".cairn/ground/brand/voice.md"), "utf8");
    assert(ngVoice.includes(SYNTH_BRAND), "0008: stamp left untouched when git can't resolve add-date");

    console.log("  ✓ 0008 — internal-doc refs / jargon / placeholder scrubbed; synthetic timestamps → git add-date; clean untouched; non-git leaves stamps");
  }

  cleanup();
  console.log("smoke-migrate-doc-repairs — pass");
}

main();
