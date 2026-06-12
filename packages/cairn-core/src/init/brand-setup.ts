/**
 * Phase 6 — interactive brand setup.
 *
 * After seedCairnLayout writes the templates with `status: draft`, ask the
 * operator 4 quick questions and flip the answered files to `status: current`.
 *
 * Skipped questions stay draft. Ctrl+C / EOF anywhere mid-flow exits gracefully
 * (whatever was answered before the abort sticks; the rest stay draft).
 *
 * Uses node:readline/promises — no new deps.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface BrandPersona {
  name: string;
  description: string;
}

export interface BrandAnswers {
  /** Q1 → product/positioning.md body. */
  whatItDoes: string;
  /**
   * Q2 → product/personas.yaml. Single-sentence freeform answer from the
   * interactive prompt path; collapses into one `name: primary` persona.
   * Auto-derive (Haiku) populates `personas` instead and leaves this empty
   * — see `derivedToBrandAnswers`.
   */
  mainUsers: string;
  /** Structured personas from the auto-derive path. Takes precedence over `mainUsers` when non-empty. */
  personas?: BrandPersona[];
  /** Q3 → brand/voice.md body. */
  voice: string;
  /** Q4 → appended to brand/voice.md as "avoid:" section. */
  avoid: string;
}

const EMPTY: BrandAnswers = {
  whatItDoes: "",
  mainUsers: "",
  voice: "",
  avoid: "",
};

export interface RunBrandSetupOptions {
  projectName: string;
  /** Skip the prompts entirely — used by smokes / scripted adoption. */
  skip?: boolean;
  /** Pre-canned answers — used by smokes to assert the apply path. */
  scriptedAnswers?: Partial<BrandAnswers>;
}

/**
 * Run the 4-question wizard. Returns whatever answers the operator provided
 * (empty string for skipped questions). Always resolves; never throws on
 * Ctrl+C / EOF — the partial answers up to the abort are returned.
 */
export async function runBrandSetup(
  opts: RunBrandSetupOptions,
): Promise<BrandAnswers> {
  if (opts.skip === true) {
    return { ...EMPTY, ...(opts.scriptedAnswers ?? {}) };
  }
  if (opts.scriptedAnswers !== undefined) {
    return { ...EMPTY, ...opts.scriptedAnswers };
  }

  stdout.write("\n  ✓ Files written.\n\n");
  stdout.write("  Fill in your project brain — 4 quick questions.\n");
  stdout.write("  Press Enter to skip any. Fill the rest later with: cairn configure\n\n");

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY === true,
  });

  // Ctrl+C inside readline emits SIGINT but rl.question() doesn't reject by
  // default — install our own handler so the operator can abort cleanly.
  rl.on("SIGINT", () => {
    rl.close();
    stdout.write(`\n  ⚠ cancelled\n`);
    process.exit(130);
  });

  const answers: BrandAnswers = { ...EMPTY };
  try {
    answers.whatItDoes = await ask(
      rl,
      `  What does ${opts.projectName} do? (one sentence)\n  › `,
    );
    answers.mainUsers = await ask(rl, `\n  Who are the main users?\n  › `);
    answers.voice = await ask(
      rl,
      `\n  How should Claude communicate in this project? (tone, style)\n  › `,
    );
    answers.avoid = await ask(rl, `\n  Anything Claude should never do here?\n  › `);
  } catch {
    // EOF / Ctrl+C / readline closed — keep whatever we got, return.
  } finally {
    rl.close();
  }
  return answers;
}

async function ask(rl: Interface, prompt: string): Promise<string> {
  const reply = await rl.question(prompt);
  return reply.trim();
}

export interface ApplyBrandOptions {
  /**
   * Flip each written file's `status` to `current` (operator-confirmed).
   * Default true — the interactive wizard collects the operator's own
   * words. The Phase-6 AUTO-DERIVE path passes false: machine-written
   * brand stays `status: draft`, which SessionStart does NOT inject, so
   * a generic first draft never pollutes context as authoritative voice.
   * The operator confirms a draft by editing the file (or re-running the
   * interactive setup), which flips it to `current`.
   */
  markCurrent?: boolean;
}

/**
 * Apply answers to the seeded templates. Empty answers are no-ops. When
 * `markCurrent` (default) the answered files flip `draft → current`;
 * the auto-derive path passes `markCurrent: false` to keep them `draft`.
 *
 * Returns the list of files that were actually rewritten.
 */
export function applyBrandAnswers(
  repoRoot: string,
  answers: BrandAnswers,
  opts: ApplyBrandOptions = {},
): { updated: string[]; warnings: string[] } {
  const markCurrent = opts.markCurrent ?? true;
  const updated: string[] = [];
  const warnings: string[] = [];

  if (answers.whatItDoes.length > 0) {
    const rel = ".cairn/ground/product/positioning.md";
    const ok = rewriteWithBody(
      join(repoRoot, rel),
      answers.whatItDoes,
      warnings,
      rel,
      markCurrent,
    );
    if (ok) updated.push(rel);
    // Also pre-fill brand/overview.md with the same domain summary —
    // gives the operator a populated starting point instead of an
    // empty `(operator: replace this paragraph...)` placeholder.
    // Operator can diverge overview vs. positioning later; until
    // then they share content.
    const overviewRel = ".cairn/ground/brand/overview.md";
    const overviewOk = rewriteWithBody(
      join(repoRoot, overviewRel),
      answers.whatItDoes,
      warnings,
      overviewRel,
      markCurrent,
    );
    if (overviewOk) updated.push(overviewRel);
  }

  if (answers.personas !== undefined && answers.personas.length > 0) {
    const rel = ".cairn/ground/product/personas.yaml";
    const ok = rewritePersonasStructured(
      join(repoRoot, rel),
      answers.personas,
      warnings,
      rel,
      markCurrent,
    );
    if (ok) updated.push(rel);
  } else if (answers.mainUsers.length > 0) {
    const rel = ".cairn/ground/product/personas.yaml";
    const ok = rewritePersonas(join(repoRoot, rel), answers.mainUsers, warnings, rel, markCurrent);
    if (ok) updated.push(rel);
  }

  if (answers.voice.length > 0 || answers.avoid.length > 0) {
    const rel = ".cairn/ground/brand/voice.md";
    const ok = rewriteVoice(
      join(repoRoot, rel),
      answers.voice,
      answers.avoid,
      warnings,
      rel,
      markCurrent,
    );
    if (ok) updated.push(rel);
  }

  return { updated, warnings };
}

function rewriteWithBody(
  abs: string,
  body: string,
  warnings: string[],
  rel: string,
  markCurrent: boolean,
): boolean {
  if (!existsSync(abs)) {
    warnings.push(`brand-setup: ${rel} missing — skipping`);
    return false;
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} unreadable: ${stringifyErr(err)}`);
    return false;
  }
  const flipped = flipStatus(text, markCurrent);
  const out = replaceBodyAfterFrontmatter(flipped, body);
  try {
    writeFileSync(abs, out, "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} write failed: ${stringifyErr(err)}`);
    return false;
  }
  return true;
}

function rewritePersonas(
  abs: string,
  description: string,
  warnings: string[],
  rel: string,
  markCurrent: boolean,
): boolean {
  if (!existsSync(abs)) {
    warnings.push(`brand-setup: ${rel} missing — skipping`);
    return false;
  }
  const next =
    `# Product personas — who this is for. Read at every SessionStart.\n` +
    `# See DOCS_SPEC.md §3.4 for shape.\n` +
    `status: ${markCurrent ? "current" : "draft"}\n` +
    `personas:\n` +
    `  - name: primary\n` +
    `    description: ${yamlSingleLine(description)}\n`;
  try {
    writeFileSync(abs, next, "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} write failed: ${stringifyErr(err)}`);
    return false;
  }
  return true;
}

/**
 * Write personas.yaml with one entry per structured persona. Used by
 * the auto-derive path; the operator-typed interactive answer path
 * still uses `rewritePersonas` (single freeform sentence collapses
 * to one `name: primary`).
 */
function rewritePersonasStructured(
  abs: string,
  personas: BrandPersona[],
  warnings: string[],
  rel: string,
  markCurrent: boolean,
): boolean {
  if (!existsSync(abs)) {
    warnings.push(`brand-setup: ${rel} missing — skipping`);
    return false;
  }
  const lines: string[] = [];
  lines.push(`# Product personas — who this is for. Read at every SessionStart.`);
  lines.push(`# See DOCS_SPEC.md §3.4 for shape.`);
  lines.push(`status: ${markCurrent ? "current" : "draft"}`);
  lines.push(`personas:`);
  for (const p of personas) {
    lines.push(`  - name: ${p.name}`);
    lines.push(`    description: ${yamlSingleLine(p.description)}`);
  }
  try {
    writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} write failed: ${stringifyErr(err)}`);
    return false;
  }
  return true;
}

function rewriteVoice(
  abs: string,
  body: string,
  avoid: string,
  warnings: string[],
  rel: string,
  markCurrent: boolean,
): boolean {
  if (!existsSync(abs)) {
    warnings.push(`brand-setup: ${rel} missing — skipping`);
    return false;
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} unreadable: ${stringifyErr(err)}`);
    return false;
  }
  const flipped = flipStatus(text, markCurrent);
  const main = body.length > 0 ? body : "(operator did not specify a voice — fill in later)";
  const avoidBlock =
    avoid.length > 0 ? `\n\n## Avoid\n\n${avoid}\n` : "";
  const out = replaceBodyAfterFrontmatter(flipped, `${main}${avoidBlock}`);
  try {
    writeFileSync(abs, out, "utf8");
  } catch (err) {
    warnings.push(`brand-setup: ${rel} write failed: ${stringifyErr(err)}`);
    return false;
  }
  return true;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;

function flipStatus(text: string, markCurrent: boolean): string {
  // Auto-derive path (markCurrent=false) leaves status untouched — the
  // seeded template is `status: draft`, and a machine-written draft must
  // stay draft so SessionStart doesn't inject it as confirmed brand.
  if (!markCurrent) return text;
  const m = text.match(FRONTMATTER_RE);
  if (!m) return text;
  const fm = m[1] ?? "";
  const flipped = /^status:\s*draft\s*$/m.test(fm)
    ? fm.replace(/^status:\s*draft\s*$/m, "status: current")
    : /^status:\s*/m.test(fm)
      ? fm
      : `${fm}status: current\n`;
  return text.replace(FRONTMATTER_RE, `---\n${flipped}---\n`);
}

function replaceBodyAfterFrontmatter(text: string, body: string): string {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return `${text.trimEnd()}\n\n${body}\n`;
  const fmBlock = m[0];
  const rest = text.slice(fmBlock.length);
  // Preserve the H1 line from the existing template, replace the rest.
  const h1Match = rest.match(/^\n*(#\s+[^\n]+\n)/);
  const headerLine = h1Match?.[1] ?? "# (untitled)\n";
  return `${fmBlock}\n${headerLine}\n${body.trimEnd()}\n`;
}

function yamlSingleLine(s: string): string {
  // Quote when the value contains characters yaml would parse oddly.
  if (/[:#&*!|>'"%@`?\-]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
