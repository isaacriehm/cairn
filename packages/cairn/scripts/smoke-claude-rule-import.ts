#!/usr/bin/env tsx
/**
 * smoke-claude-rule-import — plugin-absent onboarding wiring.
 *
 * The `.claude/rules/cairn.md` fallback only fires if the auto-loaded
 * memory file `@`-imports it. Covers:
 *   - import added to existing CLAUDE.md, idempotent on re-run
 *   - AGENTS.md targeted when CLAUDE.md is absent
 *   - CLAUDE.md created when neither exists
 *   - installCairnRuleAndImport writes the rule + wires the import
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCairnRuleImport,
  installCairnRuleAndImport,
  CAIRN_RULE_IMPORT,
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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-rule-"));
  cleanups.push(dir);
  return dir;
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — existing CLAUDE.md gets the import; re-run is idempotent");
  const r1 = mkRepo();
  writeFileSync(join(r1, "CLAUDE.md"), "# Project\n\nSome orientation.\n", "utf8");
  const a = ensureCairnRuleImport(r1);
  assert(a.changed && a.file === "CLAUDE.md" && !a.created, "added import to CLAUDE.md");
  assert(
    readFileSync(join(r1, "CLAUDE.md"), "utf8").includes(CAIRN_RULE_IMPORT),
    "CLAUDE.md now imports the cairn rule",
  );
  const b = ensureCairnRuleImport(r1);
  assert(!b.changed, "second call is a no-op (idempotent)");
  const occurrences = readFileSync(join(r1, "CLAUDE.md"), "utf8").split(CAIRN_RULE_IMPORT).length - 1;
  assert(occurrences === 1, "import line present exactly once");
  console.log("  ✓ import added once, idempotent");

  step("Step 2 — AGENTS.md targeted when CLAUDE.md is absent");
  const r2 = mkRepo();
  writeFileSync(join(r2, "AGENTS.md"), "# Agents\n", "utf8");
  const c = ensureCairnRuleImport(r2);
  assert(c.changed && c.file === "AGENTS.md", "import wired into AGENTS.md");
  console.log("  ✓ AGENTS.md fallback");

  step("Step 3 — CLAUDE.md created when neither memory file exists");
  const r3 = mkRepo();
  const d = ensureCairnRuleImport(r3);
  assert(d.changed && d.file === "CLAUDE.md" && d.created, "CLAUDE.md created with import");
  assert(
    readFileSync(join(r3, "CLAUDE.md"), "utf8").includes(CAIRN_RULE_IMPORT),
    "created CLAUDE.md carries the import",
  );
  console.log("  ✓ created CLAUDE.md");

  step("Step 4 — installCairnRuleAndImport writes the rule + wires import");
  const r4 = mkRepo();
  writeFileSync(join(r4, "CLAUDE.md"), "# P\n", "utf8");
  mkdirSync(join(r4, ".claude"), { recursive: true });
  const e = installCairnRuleAndImport(r4);
  assert(e.ruleWritten, "rule template written");
  const rule = readFileSync(join(r4, ".claude", "rules", "cairn.md"), "utf8");
  assert(/plugin/i.test(rule) && /\/plugin install/.test(rule), "rule carries install instructions");
  assert(
    readFileSync(join(r4, "CLAUDE.md"), "utf8").includes(CAIRN_RULE_IMPORT),
    "memory file imports the rule",
  );
  console.log("  ✓ rule + import installed together");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-claude-rule-import — pass");
}

main().catch((err) => {
  console.error("smoke-claude-rule-import — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
