/**
 * Inquirer-driven prompts for `harness init`.
 *
 * Per operator note 2026-05-02: harness init uses inquirer
 * (`@inquirer/prompts`) for operator-facing dialogs. Hand-rolled readline
 * was rejected as too ad-hoc.
 *
 * `mode: "auto"` short-circuits prompts so smokes / scripted adoption can
 * run non-interactively.
 */

import { input, select } from "@inquirer/prompts";

export type PromptMode = "interactive" | "auto";

export interface Choice<T extends string = string> {
  id: T;
  label: string;
  /** Distinguish the visual default (cursor lands here at first paint). */
  isDefault?: boolean;
  /** Optional sub-line shown under the choice in inquirer. */
  description?: string;
}

export interface PromptOptions<T extends string> {
  mode: PromptMode;
  /** Question shown to the operator. */
  prompt: string;
  /** 2-5 choices; one MUST be marked isDefault. */
  choices: Choice<T>[];
  /**
   * Deterministic answer when mode === "auto". MUST match a choice id.
   * Smokes set this so the wizard runs without stdin.
   */
  auto: T;
}

export async function squareIntoSquareHole<T extends string>(
  opts: PromptOptions<T>,
): Promise<T> {
  if (opts.mode === "auto") {
    if (!opts.choices.some((c) => c.id === opts.auto)) {
      throw new Error(
        `auto-mode answer "${opts.auto}" not among choices: ${opts.choices.map((c) => c.id).join(",")}`,
      );
    }
    return opts.auto;
  }
  const def = opts.choices.find((c) => c.isDefault);
  const answer = await select({
    message: opts.prompt,
    default: def?.id,
    choices: opts.choices.map((c) => ({
      name: c.label,
      value: c.id,
      ...(c.description !== undefined ? { description: c.description } : {}),
    })),
  });
  return answer;
}

export interface FreeTextOptions {
  mode: PromptMode;
  prompt: string;
  defaultValue: string;
  /** When mode === "auto" returns this directly. Defaults to defaultValue. */
  auto?: string;
}

export async function freeTextWithDefault(opts: FreeTextOptions): Promise<string> {
  if (opts.mode === "auto") return opts.auto ?? opts.defaultValue;
  return input({
    message: opts.prompt,
    default: opts.defaultValue,
  });
}

export function info(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function header(line: string): void {
  process.stdout.write(`\n── ${line}\n`);
}

export function done(line: string): void {
  process.stdout.write(`  ${line}\n`);
}
