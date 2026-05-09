#!/usr/bin/env tsx
/**
 * smoke-skill-budget — adoption-time skill-listing budget floor acceptance.
 *
 *   1. settings.json absent → wrote_new with floor and parent dir created.
 *   2. settings.json exists without the key → added_key, other keys preserved.
 *   3. value === floor → preserved, no overwrite.
 *   4. value > floor → preserved, no overwrite.
 *   5. value < floor → raised to floor.
 *   6. value non-numeric → non_numeric_skipped, file untouched.
 *   7. settings.json malformed JSON → unreadable_skipped, file untouched.
 *   8. settingsJsonPath joins to <home>/.claude/settings.json.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_BUDGET_FLOOR,
  ensureSkillBudgetFloor,
  settingsJsonPath,
} from "@isaacriehm/cairn-core";

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

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-skill-budget-"));
  cleanups.push(dir);
  return dir;
}

function readSettings(home: string): Record<string, unknown> {
  const raw = readFileSync(settingsJsonPath(home), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`settings.json should be an object, got ${raw}`);
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log("smoke-skill-budget — start");

  header("Step 1 — settings.json absent → wrote_new + parent dir created");
  {
    const home = makeHome();
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "wrote_new") fail(`expected wrote_new, got ${r.outcome}`);
    if (r.value !== SKILL_BUDGET_FLOOR) fail(`expected value=${SKILL_BUDGET_FLOOR}, got ${r.value}`);
    if (!existsSync(join(home, ".claude"))) fail(".claude dir not created");
    if (!existsSync(settingsJsonPath(home))) fail("settings.json not created");
    const obj = readSettings(home);
    if (obj["skillListingBudgetFraction"] !== SKILL_BUDGET_FLOOR) {
      fail(`floor not written, got ${obj["skillListingBudgetFraction"]}`);
    }
    pass(`new settings.json written with floor=${SKILL_BUDGET_FLOOR}`);
  }

  header("Step 2 — file exists without key → added_key, other keys intact");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsJsonPath(home),
      JSON.stringify({ theme: "dark", model: "sonnet" }, null, 2),
      "utf8",
    );
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "added_key") fail(`expected added_key, got ${r.outcome}`);
    const obj = readSettings(home);
    if (obj["skillListingBudgetFraction"] !== SKILL_BUDGET_FLOOR) {
      fail(`floor not added, got ${obj["skillListingBudgetFraction"]}`);
    }
    if (obj["theme"] !== "dark" || obj["model"] !== "sonnet") {
      fail(`other keys clobbered, got ${JSON.stringify(obj)}`);
    }
    pass("key added, other keys preserved");
  }

  header("Step 3 — value === floor → preserved (no overwrite)");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsJsonPath(home),
      JSON.stringify({ skillListingBudgetFraction: SKILL_BUDGET_FLOOR }, null, 2),
      "utf8",
    );
    const before = statSync(settingsJsonPath(home)).mtimeMs;
    // small delay so an mtime change would actually be detectable
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "preserved") fail(`expected preserved, got ${r.outcome}`);
    if (r.value !== SKILL_BUDGET_FLOOR) fail(`expected value=${SKILL_BUDGET_FLOOR}, got ${r.value}`);
    const after = statSync(settingsJsonPath(home)).mtimeMs;
    if (after !== before) fail("file was rewritten despite value at floor");
    pass("value === floor preserved without rewrite");
  }

  header("Step 4 — value > floor → preserved (no overwrite)");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsJsonPath(home),
      JSON.stringify({ skillListingBudgetFraction: 0.1 }, null, 2),
      "utf8",
    );
    const before = statSync(settingsJsonPath(home)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "preserved") fail(`expected preserved, got ${r.outcome}`);
    if (r.value !== 0.1) fail(`expected value=0.1, got ${r.value}`);
    const after = statSync(settingsJsonPath(home)).mtimeMs;
    if (after !== before) fail("file was rewritten despite value above floor");
    pass("value > floor preserved");
  }

  header("Step 5 — value < floor → raised to floor");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsJsonPath(home),
      JSON.stringify({ skillListingBudgetFraction: 0.01, theme: "dark" }, null, 2),
      "utf8",
    );
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "raised") fail(`expected raised, got ${r.outcome}`);
    if (r.value !== SKILL_BUDGET_FLOOR) fail(`expected value=${SKILL_BUDGET_FLOOR}, got ${r.value}`);
    const obj = readSettings(home);
    if (obj["skillListingBudgetFraction"] !== SKILL_BUDGET_FLOOR) {
      fail(`floor not raised, got ${obj["skillListingBudgetFraction"]}`);
    }
    if (obj["theme"] !== "dark") fail("other keys clobbered on raise");
    pass(`raised 0.01 → ${SKILL_BUDGET_FLOOR}, theme preserved`);
  }

  header("Step 6 — non-numeric value → non_numeric_skipped, file untouched");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = JSON.stringify(
      { skillListingBudgetFraction: "auto", theme: "dark" },
      null,
      2,
    );
    writeFileSync(settingsJsonPath(home), original, "utf8");
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "non_numeric_skipped") {
      fail(`expected non_numeric_skipped, got ${r.outcome}`);
    }
    if (r.value !== undefined) fail(`expected value=undefined, got ${r.value}`);
    const after = readFileSync(settingsJsonPath(home), "utf8");
    if (after !== original) fail("file was rewritten despite non-numeric value");
    pass("non-numeric value left untouched");
  }

  header("Step 7 — malformed JSON → unreadable_skipped, file untouched");
  {
    const home = makeHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = "{ not: valid json,";
    writeFileSync(settingsJsonPath(home), original, "utf8");
    const r = ensureSkillBudgetFloor({ homeDirOverride: home });
    if (r.outcome !== "unreadable_skipped") {
      fail(`expected unreadable_skipped, got ${r.outcome}`);
    }
    const after = readFileSync(settingsJsonPath(home), "utf8");
    if (after !== original) fail("malformed file was rewritten");
    pass("malformed JSON left untouched");
  }

  header("Step 8 — settingsJsonPath joins <home>/.claude/settings.json");
  {
    const home = makeHome();
    const expected = join(home, ".claude", "settings.json");
    if (settingsJsonPath(home) !== expected) {
      fail(`path mismatch: expected ${expected}, got ${settingsJsonPath(home)}`);
    }
    pass("path helper produces canonical join");
  }

  console.log("smoke-skill-budget — pass");
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
