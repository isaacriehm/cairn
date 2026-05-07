/**
 * `cairn tag --insert-marker <pattern> <file-or-dir>` — operator-driven
 * retro-tagging for existing decision docs.
 *
 * Inserts `<!-- cairn:decision -->` after each line matching `<pattern>` so
 * the phase-6 walker's marker-override path picks them up on the next
 * `cairn init` (Stage-3 deterministic, 0 Haiku — see PHASE_6_REDESIGN §4.1).
 *
 * Safety model (PHASE_6_REDESIGN §4.8):
 *
 *   1. Git-aware. Pre-flight runs `git status --porcelain <file>` for
 *      every target. If any are dirty AND `--force` is not passed, abort
 *      with the dirty-file list. Operator commits/stashes first or
 *      passes `--force`.
 *
 *   2. Impact circuit breaker. Counts pattern matches per file. If
 *      matches > 30% of total lines AND `--force-pattern` is not passed,
 *      that file is skipped with a WARN line; other files still process.
 *
 *   3. Idempotent. Scans 3 lines ahead (not 1) for an existing
 *      `<!-- cairn:decision -->` marker before inserting — handles the
 *      blank-line-between-heading-and-body case.
 *
 * Deterministic, 0 Haiku.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const IMPACT_RATIO_LIMIT = 0.30;
const MARKER_LOOKAHEAD_LINES = 3;
const MARKER_TEXT = "<!-- cairn:decision -->";

const MARKDOWN_EXTENSIONS = new Set<string>([".md", ".mdx", ".markdown"]);

interface ParsedArgs {
  insertMarker: string;
  target: string;
  force: boolean;
  forcePattern: boolean;
  repoRoot: string;
}

function usage(): never {
  process.stderr.write(
    "Usage: cairn tag --insert-marker <pattern> <file-or-dir> [--force] [--force-pattern]\n" +
      "                  [--repo <path>]\n" +
      "\n" +
      "  --insert-marker  regex pattern (per-line); marker inserted after each match\n" +
      "  <file-or-dir>    target file or directory (markdown only)\n" +
      "  --force          allow run even if targets have uncommitted changes\n" +
      "  --force-pattern  allow files where pattern matches >30% of lines\n" +
      "  --repo           repo root for git status (default: cwd)\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  let insertMarker: string | undefined;
  let target: string | undefined;
  let repoRoot = process.cwd();
  let force = false;
  let forcePattern = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--insert-marker") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--insert-marker requires a pattern argument\n");
        process.exit(2);
      }
      insertMarker = v;
      i += 1;
    } else if (arg === "--repo") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--repo requires a path argument\n");
        process.exit(2);
      }
      repoRoot = resolve(v);
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--force-pattern") {
      forcePattern = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else if (arg !== undefined && !arg.startsWith("--")) {
      if (target === undefined) target = arg;
      else {
        process.stderr.write(`unexpected positional argument: ${arg}\n`);
        process.exit(2);
      }
    } else {
      process.stderr.write(`unknown flag: ${String(arg)}\n`);
      process.exit(2);
    }
  }
  if (insertMarker === undefined || target === undefined) usage();
  return { insertMarker, target, force, forcePattern, repoRoot };
}

function resolveTargets(target: string, repoRoot: string): string[] {
  const abs = resolve(repoRoot, target);
  if (!existsSync(abs)) {
    process.stderr.write(`target does not exist: ${target}\n`);
    process.exit(2);
  }
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];
  if (!stat.isDirectory()) {
    process.stderr.write(`target is not a file or directory: ${target}\n`);
    process.exit(2);
  }
  const out: string[] = [];
  walk(abs, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".cairn") {
      continue;
    }
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(p);
    }
  }
}

function isDirty(filePath: string, repoRoot: string): boolean {
  try {
    const rel = relative(repoRoot, filePath);
    const out = execFileSync("git", ["status", "--porcelain", "--", rel], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface CmdTagResult {
  exitCode: 0 | 1;
  filesProcessed: number;
  filesSkippedHighImpact: number;
  totalInserted: number;
}

/**
 * Pure-ish entrypoint for the smoke harness — does NOT call process.exit.
 * The CLI wrapper below maps the result to stdout / stderr / exit code.
 */
export function runTag(args: {
  insertMarker: string;
  targets: string[];
  repoRoot: string;
  force: boolean;
  forcePattern: boolean;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}): CmdTagResult {
  const stdout = args.stdout ?? ((s: string): void => void process.stdout.write(s));
  const stderr = args.stderr ?? ((s: string): void => void process.stderr.write(s));

  const dirtyFiles = args.targets.filter((p) => isDirty(p, args.repoRoot));
  if (dirtyFiles.length > 0 && !args.force) {
    stderr(`Error: ${dirtyFiles.length} file${dirtyFiles.length === 1 ? "" : "s"} have uncommitted changes:\n`);
    for (const p of dirtyFiles.slice(0, 5)) {
      stderr(`  - ${relative(args.repoRoot, p)}\n`);
    }
    if (dirtyFiles.length > 5) stderr(`  - …and ${dirtyFiles.length - 5} more\n`);
    stderr(`Commit/stash first or pass --force.\n`);
    return {
      exitCode: 1,
      filesProcessed: 0,
      filesSkippedHighImpact: 0,
      totalInserted: 0,
    };
  }

  const pattern = new RegExp(args.insertMarker);
  let totalInserted = 0;
  let filesProcessed = 0;
  let filesSkippedHighImpact = 0;
  for (const file of args.targets) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (err) {
      stderr(`WARN: could not read ${relative(args.repoRoot, file)}: ${(err as Error).message}\n`);
      continue;
    }
    const lines = content.split("\n");
    const matchCount = lines.reduce((n, l) => (pattern.test(l) ? n + 1 : n), 0);
    if (matchCount === 0) {
      filesProcessed += 1;
      continue;
    }
    const ratio = matchCount / Math.max(1, lines.length);
    if (ratio > IMPACT_RATIO_LIMIT && !args.forcePattern) {
      stderr(
        `WARN: pattern matched ${(ratio * 100).toFixed(0)}% of lines in ${relative(args.repoRoot, file)}. Skipping. Use --force-pattern to override.\n`,
      );
      filesSkippedHighImpact += 1;
      continue;
    }

    const out: string[] = [];
    let insertedHere = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      out.push(line);
      if (pattern.test(line)) {
        const window = lines.slice(i + 1, i + 1 + MARKER_LOOKAHEAD_LINES).join("\n");
        if (!window.includes(MARKER_TEXT)) {
          out.push(MARKER_TEXT);
          insertedHere += 1;
        }
      }
    }
    if (insertedHere > 0) {
      writeFileSync(file, out.join("\n"), "utf8");
      totalInserted += insertedHere;
    }
    filesProcessed += 1;
  }

  stdout(
    `Inserted ${totalInserted} marker${totalInserted === 1 ? "" : "s"} across ${filesProcessed} file${filesProcessed === 1 ? "" : "s"}.\n`,
  );
  if (filesSkippedHighImpact > 0) {
    stdout(`Skipped ${filesSkippedHighImpact} file${filesSkippedHighImpact === 1 ? "" : "s"} (impact circuit breaker).\n`);
  }
  return {
    exitCode: 0,
    filesProcessed,
    filesSkippedHighImpact,
    totalInserted,
  };
}

export async function tagCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const targets = resolveTargets(parsed.target, parsed.repoRoot);
  if (targets.length === 0) {
    process.stderr.write(`No markdown targets resolved under: ${parsed.target}\n`);
    process.exit(2);
  }
  const result = runTag({
    insertMarker: parsed.insertMarker,
    targets,
    repoRoot: parsed.repoRoot,
    force: parsed.force,
    forcePattern: parsed.forcePattern,
  });
  process.exit(result.exitCode);
}

export const _internal = {
  IMPACT_RATIO_LIMIT,
  MARKER_LOOKAHEAD_LINES,
  MARKER_TEXT,
};
