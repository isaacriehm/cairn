/**
 * CLI prompt primitives for `harness init`.
 *
 * Squares-into-square-holes (L13 / L22): every operator interaction is a
 * lettered choice, default highlighted, free text only as `E) Other`. Stdin
 * read uses readline; non-TTY contexts (smoke tests, scripted adoption) skip
 * prompts via `mode: "auto"` and use the `auto` value preconfigured per call.
 *
 * No inquirer — operator preference for fewer moving pieces. Hand-rolled
 * readline gets us A/B/C/D + free text without a dep.
 */

import { createInterface } from "node:readline";

export type PromptMode = "interactive" | "auto";

export interface Choice<T extends string = string> {
  id: T;
  label: string;
  /** Distinguish the visual default; pressing return alone selects it. */
  isDefault?: boolean;
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
  process.stdout.write(`\n${opts.prompt}\n`);
  for (const c of opts.choices) {
    const marker = c.isDefault ? "*" : " ";
    process.stdout.write(`  ${marker} [${c.id}] ${c.label}\n`);
  }
  const hint = def !== undefined ? ` (enter for [${def.id}])` : "";
  process.stdout.write(`> ${hint}: `);

  const answer = await readLine();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed.length === 0 && def !== undefined) return def.id;
  const match = opts.choices.find((c) => c.id.toLowerCase() === trimmed);
  if (match) return match.id;
  process.stdout.write(`unknown choice "${trimmed}" — using default ${def?.id ?? opts.choices[0]!.id}\n`);
  return def?.id ?? (opts.choices[0]!.id as T);
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
  process.stdout.write(`\n${opts.prompt}\n  default: ${opts.defaultValue}\n> `);
  const answer = await readLine();
  return answer.trim().length === 0 ? opts.defaultValue : answer.trim();
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

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
  });
}
