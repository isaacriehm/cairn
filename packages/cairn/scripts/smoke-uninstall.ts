#!/usr/bin/env tsx
/**
 * smoke-uninstall — `cairn uninstall` (CAIRN_ISSUES item 6, uninstall flow).
 *
 * Real install→uninstall round trip. Asserts the inverse of adoption:
 *
 *   Step 1 — stripImportBlock removes the marker + import lines cleanly.
 *   Step 2 — dry-run mutates nothing.
 *   Step 3 — apply: cites expanded inline, .cairn/ removed, rule file
 *            removed, import unwired from CLAUDE.md (file kept), Cairn's
 *            core.hooksPath unset.
 *   Step 4 — a FOREIGN core.hooksPath is never clobbered (warn, left).
 *   Step 5 — --keep-cites leaves §tokens in source.
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
  CAIRN_RULE_IMPORT,
  bodyContentHash,
  installCairnRuleAndImport,
  stripImportBlock,
  uninstallCairn,
  writeScopeIndex,
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
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function gitConfigGet(repo: string, key: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd: repo, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Build a fully adopted repo: config, a decision, a cited source file, the
 *  plugin-absent rule + import, and Cairn's git-hook path. */
function mkAdoptedRepo(): { repo: string; decId: string } {
  const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-uninstall-"));
  cleanups.push(repo);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repo });

  mkdirSync(join(repo, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(join(repo, ".cairn", "git-hooks"), { recursive: true });
  writeFileSync(join(repo, ".cairn", "config.yaml"), "version: 1\ncairn_version: 0.22.6\nslug: smoke\n", "utf8");

  const decId = "DEC-1234567";
  const body = "Chose BullMQ over Sidekiq for the Node-native runtime.";
  writeFileSync(
    join(repo, ".cairn", "ground", "decisions", `${decId}.md`),
    [
      "---",
      `id: ${decId}`,
      "title: Jobs",
      "type: adr",
      "status: accepted",
      "audience: dual",
      "sot_kind: ledger",
      "sot_path: ledger",
      `sot_content_hash: ${bodyContentHash(body)}`,
      "capture_source: smoke",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );

  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "jobs.ts"), `// §${decId}\nexport function jobs() {}\n`, "utf8");
  writeScopeIndex(repo, {
    generated: "2026-01-01T00:00:00Z",
    files: { "src/jobs.ts": { decisions: [decId], invariants: [] } },
  });

  installCairnRuleAndImport(repo); // writes .claude/rules/cairn.md + CLAUDE.md import
  execFileSync("git", ["config", "core.hooksPath", ".cairn/git-hooks"], { cwd: repo });
  return { repo, decId };
}

function main(): void {
  console.log("smoke-uninstall — start");

  // ── Step 1 — stripImportBlock pure ───────────────────────────────
  {
    const before = `# My Project\n\nSome notes.\n\n<!-- cairn: plugin-absent onboarding — loads the install notice for clones without the Cairn plugin -->\n${CAIRN_RULE_IMPORT}\n`;
    const after = stripImportBlock(before);
    assert(!after.includes(CAIRN_RULE_IMPORT), "Step 1: import line removed");
    assert(!after.includes("cairn: plugin-absent"), "Step 1: marker removed");
    assert(after.includes("# My Project") && after.includes("Some notes."), "Step 1: operator content preserved");
    assert(!/\n{3,}/.test(after), "Step 1: no 3+ blank-line run left behind");
    console.log("  ✓ Step 1 — stripImportBlock removes block, keeps content");
  }

  // ── Step 2 — dry-run mutates nothing ─────────────────────────────
  {
    const { repo } = mkAdoptedRepo();
    const srcBefore = readFileSync(join(repo, "src", "jobs.ts"), "utf8");
    const r = uninstallCairn({ repoRoot: repo, dryRun: true });
    assert(r.removed === true, "Step 2: plan would remove .cairn/");
    assert(existsSync(join(repo, ".cairn")), "Step 2: .cairn/ still present after dry-run");
    assert(existsSync(join(repo, ".claude", "rules", "cairn.md")), "Step 2: rule file still present");
    assert(readFileSync(join(repo, "src", "jobs.ts"), "utf8") === srcBefore, "Step 2: source untouched");
    assert(readFileSync(join(repo, "CLAUDE.md"), "utf8").includes(CAIRN_RULE_IMPORT), "Step 2: import still present");
    assert(gitConfigGet(repo, "core.hooksPath") === ".cairn/git-hooks", "Step 2: hooksPath still set");
    console.log("  ✓ Step 2 — dry-run changes nothing");
  }

  // ── Step 3 — apply removes everything, cites inlined ─────────────
  {
    const { repo } = mkAdoptedRepo();
    const r = uninstallCairn({ repoRoot: repo });
    assert(r.removed === true, "Step 3: .cairn/ removed");

    const src = readFileSync(join(repo, "src", "jobs.ts"), "utf8");
    assert(src.includes("// Chose BullMQ over Sidekiq"), "Step 3: cite expanded to body inline");
    assert(!src.includes("§DEC-"), "Step 3: no §token remains in source");

    assert(!existsSync(join(repo, ".cairn")), "Step 3: .cairn/ gone");
    assert(!existsSync(join(repo, ".claude", "rules", "cairn.md")), "Step 3: rule file gone");
    // .claude/ had only rules/cairn.md → pruned entirely
    assert(!existsSync(join(repo, ".claude")), "Step 3: empty .claude/ pruned");

    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    assert(!claudeMd.includes(CAIRN_RULE_IMPORT), "Step 3: import unwired from CLAUDE.md");
    assert(existsSync(join(repo, "CLAUDE.md")), "Step 3: CLAUDE.md itself kept");

    assert(gitConfigGet(repo, "core.hooksPath") === null, "Step 3: core.hooksPath unset");
    console.log("  ✓ Step 3 — apply: cites inlined, .cairn/+rule+import+hooks removed");
  }

  // ── Step 4 — foreign hooksPath is never clobbered ────────────────
  {
    const { repo } = mkAdoptedRepo();
    execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: repo });
    const r = uninstallCairn({ repoRoot: repo });
    const hooksStep = r.steps.find((s) => s.step === "unset-hooks");
    assert(hooksStep?.status === "warn", "Step 4: foreign hooksPath warned");
    assert(gitConfigGet(repo, "core.hooksPath") === ".husky", "Step 4: foreign hooksPath left intact");
    console.log("  ✓ Step 4 — foreign core.hooksPath left untouched");
  }

  // ── Step 5 — --keep-cites leaves §tokens ─────────────────────────
  {
    const { repo, decId } = mkAdoptedRepo();
    uninstallCairn({ repoRoot: repo, expandCites: false });
    // .cairn/ is gone, but we read the source we captured by re-reading file.
    const src = readFileSync(join(repo, "src", "jobs.ts"), "utf8");
    assert(src.includes(`§${decId}`), "Step 5: --keep-cites leaves the §token in source");
    console.log("  ✓ Step 5 — --keep-cites preserves source §tokens");
  }

  cleanup();
  console.log("\nsmoke-uninstall — pass");
}

try {
  main();
} catch (err) {
  console.error("smoke-uninstall — fail");
  console.error(err);
  cleanup();
  process.exit(1);
}
