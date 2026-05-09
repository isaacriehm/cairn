/**
 * Skill-listing budget floor — auto-bump on adoption.
 *
 * Claude Code reserves a fraction of the active model's context window
 * for the skill listing (default 1%). On Sonnet (200k) that's ~2k chars,
 * which routinely truncates `cairn-direction`'s description on machines
 * with ~20+ user skills — once the description is dropped the
 * auto-invoke trigger gate never sees the prompt. Adoption silently
 * raises the floor to 0.03 in `~/.claude/settings.json` so Sonnet/Haiku
 * keep listing the cairn skills in full.
 *
 * Idempotent. Writes when:
 *   - settings.json doesn't exist (create with `{ skillListingBudgetFraction: 0.03 }`)
 *   - settings.json exists but lacks the key
 *   - settings.json exists with a finite numeric value below the floor
 *
 * Existing values at or above the floor are preserved untouched.
 * Non-numeric and unparseable cases are skipped (don't clobber operator
 * edits or third-party JSON shapes).
 *
 * Failures are non-fatal — adoption never aborts because user-level
 * config couldn't be patched.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SKILL_BUDGET_FLOOR = 0.03;

export interface EnsureSkillBudgetOptions {
  /** Test injection. Defaults to `homedir()`. */
  homeDirOverride?: string;
  /** Test injection. Defaults to `SKILL_BUDGET_FLOOR`. */
  floor?: number;
}

export type EnsureSkillBudgetOutcome =
  | "wrote_new"
  | "added_key"
  | "raised"
  | "preserved"
  | "non_numeric_skipped"
  | "unreadable_skipped"
  | "write_failed";

export interface EnsureSkillBudgetResult {
  outcome: EnsureSkillBudgetOutcome;
  /** Final on-disk value after the call (undefined on skip/failure). */
  value: number | undefined;
  settingsPath: string;
}

export function settingsJsonPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

export function ensureSkillBudgetFloor(
  opts: EnsureSkillBudgetOptions = {},
): EnsureSkillBudgetResult {
  const home = opts.homeDirOverride ?? homedir();
  const floor = opts.floor ?? SKILL_BUDGET_FLOOR;
  const path = settingsJsonPath(home);

  if (!existsSync(path)) {
    const next = { skillListingBudgetFraction: floor };
    if (!writeJson(path, next)) {
      return { outcome: "write_failed", value: undefined, settingsPath: path };
    }
    return { outcome: "wrote_new", value: floor, settingsPath: path };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { outcome: "unreadable_skipped", value: undefined, settingsPath: path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: "unreadable_skipped", value: undefined, settingsPath: path };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return { outcome: "unreadable_skipped", value: undefined, settingsPath: path };
  }

  const obj = parsed as Record<string, unknown>;
  const existing = obj["skillListingBudgetFraction"];

  if (typeof existing === "undefined") {
    obj["skillListingBudgetFraction"] = floor;
    if (!writeJson(path, obj)) {
      return { outcome: "write_failed", value: undefined, settingsPath: path };
    }
    return { outcome: "added_key", value: floor, settingsPath: path };
  }

  if (typeof existing !== "number" || !Number.isFinite(existing)) {
    return {
      outcome: "non_numeric_skipped",
      value: undefined,
      settingsPath: path,
    };
  }

  if (existing >= floor) {
    return { outcome: "preserved", value: existing, settingsPath: path };
  }

  obj["skillListingBudgetFraction"] = floor;
  if (!writeJson(path, obj)) {
    return { outcome: "write_failed", value: undefined, settingsPath: path };
  }
  return { outcome: "raised", value: floor, settingsPath: path };
}

function writeJson(path: string, body: unknown): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
