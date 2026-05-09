/**
 * `cairn fix` — retroactive repair subcommands for projects adopted
 * before a feature landed.
 *
 * Subcommands:
 *
 *   - `cairn fix brand` — re-run the Phase 5 Haiku brand derivation
 *     against the mapper output already on disk and rewrite the 4
 *     brand files (overview, voice, positioning, personas). Useful
 *     for projects adopted under v0.3.8 or earlier when the
 *     brand-derive Haiku call was timing out and the mapper picked
 *     mechanical defaults instead.
 *
 *   - `cairn fix dec-strip` — replay source-comment strip-replace for
 *     accepted DECs whose original essay block is still in source.
 *     For projects adopted under v0.4.0 builds before the dirty-file
 *     overwrite fix landed: their accepted DECs sit in
 *     `.cairn/ground/decisions/<id>.md` but the originating source
 *     file still carries the prose instead of `// §DEC-NNNN`.
 *
 *   - `cairn fix confidence` — pointer to `cairn attention bulk-accept
 *     --threshold high --dry-run`, which already scores + stamps
 *     `capture_confidence` on every draft + invariant. Documented
 *     here so operators don't hunt for it; this subcommand defers
 *     to the existing tool.
 *
 *   - `cairn fix duration_ms` — pointer-only. Phase durations are
 *     recorded going forward; pre-v0.4.0 init runs cannot be
 *     retroactively backfilled because the trace doesn't carry
 *     phase boundaries.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  applyBrandAnswers,
  deriveBrandFromProject,
  derivedToBrandAnswers,
  gitDirtyPathsInScope,
  parseDraftMeta,
  readMapperOutputFile,
  runDecSourceStrip,
  runFixAlign,
  validateFixAlignSentinel,
  writeFixAlignSentinel,
  type BrandAnswers,
  type FixAlignArgs,
  type FixAlignResult,
} from "@isaacriehm/cairn-core";
import { z } from "zod";

const ConfigSchema = z.object({
  version: z.number(),
  source: z.string(),
  repo: z.string(),
  phases: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  project_slug: z.string().optional(),
}).passthrough();
import { fixCli as doctorFixCli } from "./doctor.js";

function parseRepoFlag(argv: string[]): string {
  const idx = argv.indexOf("--repo");
  if (idx === -1) return process.cwd();
  const candidate = argv[idx + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    console.error("--repo requires a path argument");
    process.exit(2);
  }
  return resolve(candidate);
}

function ensureAdopted(repoRoot: string): void {
  if (!existsSync(repoRoot)) {
    console.error(`cairn fix: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!existsSync(join(repoRoot, ".cairn"))) {
    console.error(
      `cairn fix: ${repoRoot} is not cairn-adopted (no .cairn/). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
}

function readProjectSlug(repoRoot: string): string {
  const cfgPath = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(cfgPath)) return "this-project";
  try {
    const raw = readFileSync(cfgPath, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (result.success && result.data.project_slug !== undefined) {
      return result.data.project_slug;
    }
  } catch {
    /* fallback to this-project */
  }
  return "this-project";
}

async function fixBrand(repoRoot: string, dryRun: boolean): Promise<void> {
  const mapper = readMapperOutputFile(repoRoot);
  if (mapper === null) {
    console.error(
      `cairn fix brand: no mapper output at .cairn/init/mapper-output.json. ` +
        `Re-run \`cairn init\` first so the mapper can produce a domain summary.`,
    );
    process.exit(2);
  }
  const domainSummary = mapper.output.domain_summary;
  const projectSlug = readProjectSlug(repoRoot);
  process.stdout.write(
    `  ⬡ cairn fix brand — ${repoRoot}\n` +
      `    project_slug: ${projectSlug}\n` +
      `    domain_summary: ${domainSummary.slice(0, 80)}${domainSummary.length > 80 ? "…" : ""}\n` +
      `\n  Calling Haiku for brand-derive (60s timeout, 2-attempt retry)…\n`,
  );
  const derived = await deriveBrandFromProject({
    repoRoot,
    projectSlug,
    domainSummary,
  });
  if (derived === null) {
    console.error(
      `cairn fix brand: Haiku call returned no usable brand. ` +
        `Check the trace for the underlying error and retry.`,
    );
    process.exit(2);
  }
  const answers: BrandAnswers = derivedToBrandAnswers(derived);
  if (dryRun) {
    process.stdout.write("  [dry-run] would rewrite 4 brand files:\n");
    process.stdout.write(`    overview: ${answers.whatItDoes.slice(0, 60)}…\n`);
    process.stdout.write(`    voice:    ${answers.voice.slice(0, 60)}…\n`);
    process.stdout.write(`    avoid:    ${answers.avoid.slice(0, 60)}…\n`);
    process.stdout.write(`    personas: ${answers.mainUsers.slice(0, 60)}…\n`);
    process.exit(0);
  }
  const result = applyBrandAnswers(repoRoot, answers);
  process.stdout.write(`  Updated ${result.updated.length} file(s):\n`);
  for (const f of result.updated) {
    process.stdout.write(`    • ${f}\n`);
  }
  if (result.warnings.length > 0) {
    process.stdout.write("  Warnings:\n");
    for (const w of result.warnings) {
      process.stdout.write(`    ! ${w}\n`);
    }
  }
  process.exit(0);
}

async function fixDecStrip(repoRoot: string, dryRun: boolean): Promise<void> {
  const decisionsDir = join(repoRoot, ".cairn", "ground", "decisions");
  if (!existsSync(decisionsDir)) {
    console.error(
      `cairn fix dec-strip: no decisions dir at ${decisionsDir}. Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
  let entries: string[];
  try {
    entries = readdirSync(decisionsDir, { encoding: "utf8" });
  } catch (err) {
    console.error(
      `cairn fix dec-strip: cannot read decisions dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  const decFiles = entries.filter(
    (n) => /^DEC-[0-9a-f]{7,}\.md$/.test(n) && !n.endsWith(".draft.md"),
  );
  process.stdout.write(
    `  ⬡ cairn fix dec-strip${dryRun ? " --dry-run" : ""} — ${repoRoot}\n` +
      `    Scanning ${decFiles.length} accepted DEC(s) under .cairn/ground/decisions/\n\n`,
  );

  let scanned = 0;
  let candidates = 0;
  let attempted = 0;
  let applied = 0;
  let alreadyStripped = 0;
  let skipped = 0;
  const skipReasons: { id: string; reason: string }[] = [];

  for (const name of decFiles) {
    scanned += 1;
    const abs = join(decisionsDir, name);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const meta = parseDraftMeta(body);
    if (
      meta === null ||
      meta.captureSource !== "init-source-comments" ||
      meta.blockId === null
    ) {
      continue;
    }
    candidates += 1;
    const decId = name.replace(/\.md$/, "");
    if (dryRun) {
      process.stdout.write(
        `    [dry-run] ${decId} — would strip block ${meta.blockId} in ${meta.sourceFile ?? "?"}\n`,
      );
      continue;
    }
    const outcome = runDecSourceStrip({ repoRoot, decId, meta });
    attempted += outcome.attempted ? 1 : 0;
    applied += outcome.items_applied;
    if (outcome.reason === "already-stripped") {
      alreadyStripped += 1;
      process.stdout.write(`    · ${decId} — already stripped (no-op)\n`);
      continue;
    }
    if (outcome.items_applied === 0) {
      skipped += 1;
      skipReasons.push({ id: decId, reason: outcome.reason ?? "unknown" });
      process.stdout.write(
        `    ✗ ${decId} — skipped (${outcome.reason ?? "unknown"})\n`,
      );
    } else {
      process.stdout.write(
        `    ✓ ${decId} — replaced ${outcome.items_applied} block(s) in ${outcome.files_modified} file(s)\n`,
      );
    }
  }

  process.stdout.write(
    `\n  Scanned ${scanned}, candidates ${candidates}, attempted ${attempted}, applied ${applied}, already-stripped ${alreadyStripped}, skipped ${skipped}\n`,
  );
  if (!dryRun && skipReasons.length > 0) {
    process.stdout.write("\n  Skip reason breakdown:\n");
    const counts = new Map<string, number>();
    for (const r of skipReasons) {
      counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    }
    for (const [reason, n] of counts) {
      process.stdout.write(`    ${reason}: ${n}\n`);
    }
    process.stdout.write(
      `\n  Common reasons:\n` +
        `    no-audit-found     — Phase 7b audit YAML missing (re-run \`cairn init\` or restore baseline)\n` +
        `    block-not-found    — block id not in audit (DEC was edited or audit predates block)\n` +
        `    range-mismatch     — audit offset + content-search both stale; source file edited post-init\n` +
        `    raw-not-in-file    — original essay text not in current source (file edited post-init)\n` +
        `    strip-failed       — source file moved or content drifted\n`,
    );
  }
  process.exit(0);
}

async function fixClaudeRules(repoRoot: string, dryRun: boolean): Promise<void> {
  const targetRel = ".claude/rules/cairn.md";
  const targetAbs = join(repoRoot, targetRel);
  // Locate the bundled template alongside the gitignore template.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "cairn-core", "templates", ".claude", "rules", "cairn.md"),
    join(here, "..", "..", "..", "..", "cairn-core", "templates", ".claude", "rules", "cairn.md"),
    join(here, "..", "..", "templates", ".claude", "rules", "cairn.md"),
    join(here, "..", "templates", ".claude", "rules", "cairn.md"),
  ];
  const templatePath = candidates.find((p) => existsSync(p));
  if (templatePath === undefined) {
    console.error(
      `cairn fix claude-rules: cannot locate bundled .claude/rules/cairn.md template (looked in ${candidates.join(", ")})`,
    );
    process.exit(2);
  }
  const templateContent = readFileSync(templatePath, "utf8");
  process.stdout.write(
    `  ⬡ cairn fix claude-rules${dryRun ? " --dry-run" : ""} — ${repoRoot}\n` +
      `    template: ${templatePath}\n    target:   ${targetRel}\n\n`,
  );
  if (existsSync(targetAbs)) {
    const current = readFileSync(targetAbs, "utf8");
    if (current === templateContent) {
      process.stdout.write("  · already matches template (no-op)\n");
      process.exit(0);
    }
    process.stdout.write("  ! existing file differs from template\n");
    if (dryRun) {
      process.stdout.write(`  [dry-run] would overwrite ${targetRel}\n`);
      process.exit(0);
    }
    writeFileSync(targetAbs, templateContent, "utf8");
    process.stdout.write(`  ✓ ${targetRel} overwritten with current template\n`);
    process.exit(0);
  }
  if (dryRun) {
    process.stdout.write(`  [dry-run] would write ${targetRel}\n`);
    process.exit(0);
  }
  // mkdir -p .claude/rules/
  const targetDir = dirname(targetAbs);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  writeFileSync(targetAbs, templateContent, "utf8");
  process.stdout.write(
    `  ✓ ${targetRel} written\n` +
      `\n  Teammates without the Cairn plugin will now see install\n` +
      `  instructions on session start. Commit the file:\n` +
      `    git add ${targetRel}\n` +
      `    git commit -m "cairn: add .claude/rules/cairn.md for plugin-absent onboarding"\n`,
  );
  process.exit(0);
}

async function fixScrubCache(repoRoot: string, dryRun: boolean): Promise<void> {
  const cacheDir = join(repoRoot, ".cairn", "cache", "haiku");
  if (!existsSync(cacheDir)) {
    process.stdout.write(
      `  ⬡ cairn fix scrub-cache — ${repoRoot}\n` +
        `  · no cache at ${cacheDir} (nothing to scrub)\n`,
    );
    process.exit(0);
  }
  let entries: string[];
  try {
    entries = readdirSync(cacheDir, { encoding: "utf8" });
  } catch (err) {
    console.error(
      `cairn fix scrub-cache: cannot read cache dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  const cacheFiles = entries.filter((n) => n.endsWith(".json"));
  process.stdout.write(
    `  ⬡ cairn fix scrub-cache${dryRun ? " --dry-run" : ""} — ${repoRoot}\n` +
      `    Found ${cacheFiles.length} cache entr(y/ies) at ${cacheDir}\n\n`,
  );
  if (cacheFiles.length === 0) {
    process.stdout.write("  · cache dir is empty (nothing to scrub)\n");
    process.exit(0);
  }
  if (dryRun) {
    process.stdout.write(`  [dry-run] would delete ${cacheFiles.length} entr(y/ies)\n`);
    process.exit(0);
  }
  let removed = 0;
  for (const name of cacheFiles) {
    try {
      rmSync(join(cacheDir, name), { force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  process.stdout.write(
    `  ✓ Scrubbed ${removed} entr(y/ies). Next Haiku call will re-populate.\n` +
      `\n  Recommended next step: re-run \`cairn fix brand\` to regenerate the\n` +
      `  brand text from a clean run (use this if the prior brand text picked\n` +
      `  up content from your user-global ~/.claude/CLAUDE.md or other ambient\n` +
      `  context — v0.4.0 added isolation that prevents this going forward).\n`,
  );
  process.exit(0);
}

async function fixGitignore(repoRoot: string, dryRun: boolean): Promise<void> {
  const cairnGitignorePath = join(repoRoot, ".cairn", ".gitignore");
  if (!existsSync(cairnGitignorePath)) {
    console.error(
      `cairn fix gitignore: missing ${cairnGitignorePath}. Re-run \`cairn init\`.`,
    );
    process.exit(2);
  }
  // Resolve the bundled template via the cli's own location. In the
  // npm-published layout dist/cli/index.js sits next to the cairn-core
  // package; the templates live under cairn-core/templates/. In the
  // Claude Code plugin bundle layout, the template is shipped under
  // dist/templates/. Try both — fail loudly if neither exists.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "cairn-core", "templates", ".cairn", ".gitignore"),
    join(here, "..", "..", "..", "..", "cairn-core", "templates", ".cairn", ".gitignore"),
    join(here, "..", "..", "templates", ".cairn", ".gitignore"),
    join(here, "..", "templates", ".cairn", ".gitignore"),
  ];
  const templatePath = candidates.find((p) => existsSync(p));
  if (templatePath === undefined) {
    console.error(
      `cairn fix gitignore: cannot locate bundled .cairn/.gitignore template (looked in ${candidates.join(", ")})`,
    );
    process.exit(2);
  }
  const templateContent = readFileSync(templatePath, "utf8");
  const currentContent = readFileSync(cairnGitignorePath, "utf8");
  process.stdout.write(
    `  ⬡ cairn fix gitignore${dryRun ? " --dry-run" : ""} — ${repoRoot}\n` +
      `    template: ${templatePath}\n\n`,
  );

  if (templateContent === currentContent) {
    process.stdout.write("  ✓ .cairn/.gitignore already matches template — no changes needed\n");
    process.exit(0);
  }

  // Compute newly-ignored top-level entries by diffing entry lines (any
  // non-comment, non-blank line). Only entries the OLD file lacked but
  // the NEW one adds get the `git rm --cached` treatment — entries the
  // operator added themselves stay alone.
  const lineEntries = (text: string): Set<string> =>
    new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#")),
    );
  const before = lineEntries(currentContent);
  const after = lineEntries(templateContent);
  const newlyIgnored = [...after].filter((e) => !before.has(e));

  process.stdout.write(`  Newly-ignored entries (${newlyIgnored.length}):\n`);
  for (const e of newlyIgnored) {
    process.stdout.write(`    + ${e}\n`);
  }

  if (dryRun) {
    process.stdout.write(
      `\n  [dry-run] would rewrite .cairn/.gitignore from template\n`,
    );
    if (newlyIgnored.length > 0) {
      process.stdout.write(
        `  [dry-run] would run \`git rm --cached -r --ignore-unmatch\` against newly-ignored entries\n`,
      );
    }
    process.exit(0);
  }

  writeFileSync(cairnGitignorePath, templateContent, "utf8");
  process.stdout.write("\n  ✓ .cairn/.gitignore rewritten from template\n");

  if (newlyIgnored.length === 0) {
    process.exit(0);
  }
  // Untrack newly-ignored paths so they actually drop out of the index.
  // Paths in .cairn/.gitignore are relative to .cairn/, so prefix.
  const targets = newlyIgnored.map((e) => join(".cairn", e));
  process.stdout.write(
    `\n  Running \`git rm --cached -r --ignore-unmatch\` for ${targets.length} path(s)…\n`,
  );
  try {
    const out = execFileSync(
      "git",
      ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...targets],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (out.trim().length > 0) {
      for (const line of out.trim().split("\n")) {
        process.stdout.write(`    ${line}\n`);
      }
    } else {
      process.stdout.write("    (nothing to untrack — paths weren't committed)\n");
    }
  } catch (err) {
    console.error(
      `cairn fix gitignore: git rm --cached failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  process.stdout.write(
    "\n  Untracked. Commit the .gitignore + index changes when you're ready:\n" +
      "    git status\n" +
      "    git add .cairn/.gitignore\n" +
      '    git commit -m "cairn: tighten .cairn/.gitignore (untrack transient state)"\n',
  );
  process.exit(0);
}

const RETROACTIVE_SUBCOMMANDS = new Set([
  "align",
  "brand",
  "dec-strip",
  "gitignore",
  "scrub-cache",
  "claude-rules",
  "confidence",
  "duration_ms",
]);

function parseAlignFlags(argv: string[]): {
  dryRun: boolean;
  force: boolean;
  maxCost: number | null;
  include: string[];
  exclude: string[];
  skipCreation: boolean;
} {
  const flags = {
    dryRun: false,
    force: false,
    maxCost: null as number | null,
    include: [] as string[],
    exclude: [] as string[],
    skipCreation: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a === "--no-creation") {
      flags.skipCreation = true;
    } else if (a === "--max-cost") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--max-cost requires a token value");
        process.exit(2);
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`--max-cost invalid: ${v}`);
        process.exit(2);
      }
      flags.maxCost = n;
      i += 1;
    } else if (a === "--include") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--include requires a glob");
        process.exit(2);
      }
      flags.include.push(v);
      i += 1;
    } else if (a === "--exclude") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--exclude requires a glob");
        process.exit(2);
      }
      flags.exclude.push(v);
      i += 1;
    } else if (a === "--repo") {
      // Consumed by parseRepoFlag earlier; skip its value too.
      i += 1;
    } else {
      console.error(`cairn fix align: unknown flag "${a}"`);
      process.exit(2);
    }
  }
  return flags;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function renderPreflight(result: FixAlignResult): string {
  const p = result.preflight;
  const lines: string[] = [];
  lines.push(`    files scanned:                ${p.filesScanned}`);
  lines.push(`    blocks considered:            ${p.blocksConsidered}`);
  lines.push(`    short / sub-floor blocks:     ${p.shortBlocks}`);
  lines.push(`    blocks w/ Tier 1 candidates:  ${p.blocksWithTier1Candidates}`);
  lines.push(`    blocks w/o candidates:        ${p.blocksWithoutCandidates}`);
  lines.push(`    Pass-1 Haiku calls (est):     ${p.estimatedPass1Calls}`);
  lines.push(`    Pass-2 Haiku calls (est):     ${p.estimatedPass2Calls}`);
  lines.push(`    Tier 3 creation calls (est):  ${p.estimatedCreationCalls}`);
  lines.push(`    total tokens (est):           ~${formatTokens(p.estimatedTokens)}`);
  return lines.join("\n");
}

function renderApply(result: FixAlignResult): string {
  if (result.apply === null) return "    (apply phase did not run)";
  const a = result.apply;
  const lines: string[] = [];
  lines.push(`    files aligned:                ${a.filesAligned}`);
  lines.push(`    Tier 1 deterministic cites:   ${a.tier1Aligned}`);
  lines.push(`    Tier 2 Haiku-confirmed cites: ${a.tier2Aligned}`);
  lines.push(`    fresh DECs created:           ${a.decsCreated}`);
  lines.push(`    fresh INVs created:           ${a.invsCreated}`);
  lines.push(`    augments DECs:                ${a.augmentsDecs}`);
  lines.push(`    augments INVs:                ${a.augmentsInvs}`);
  lines.push(`    descriptive (no-op):          ${a.descriptive}`);
  lines.push(`    alignment-pending queued:     ${a.pending}`);
  lines.push(`    deferred to staleness:        ${a.deferredToStaleness}`);
  lines.push(`    skipped (length / token):     ${a.skipped}`);
  lines.push(`    Pass-1 Haiku calls (actual):  ${a.haikuPass1Calls}`);
  lines.push(`    Pass-2 Haiku calls (actual):  ${a.haikuPass2Calls}`);
  lines.push(`    total Haiku calls:            ${a.haikuCalls}`);
  return lines.join("\n");
}

async function fixAlign(repoRoot: string, argv: string[]): Promise<void> {
  const flags = parseAlignFlags(argv);
  const sentinelArgs = {
    include: flags.include,
    exclude: flags.exclude,
    skipCreation: flags.skipCreation,
    maxCost: flags.maxCost,
  };

  // Apply-phase gates (skipped on --dry-run and on --force).
  if (!flags.dryRun && !flags.force) {
    const sentinel = validateFixAlignSentinel(repoRoot, sentinelArgs);
    if (!sentinel.ok) {
      process.stdout.write(
        `  ⬡ cairn fix align — ${repoRoot}\n\n` +
          `  ✗ aborted — ${sentinel.detail}.\n` +
          `  Re-run \`cairn fix align --dry-run\` with the same flags first, or pass --force.\n`,
      );
      process.exit(2);
    }
    const dirty = gitDirtyPathsInScope(repoRoot, flags.include);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).map((d) => `    ${d.status} ${d.path}`).join("\n");
      const overflow = dirty.length > 5 ? `\n    … and ${dirty.length - 5} more` : "";
      process.stdout.write(
        `  ⬡ cairn fix align — ${repoRoot}\n\n` +
          `  ✗ aborted — working tree dirty within sweep scope (${dirty.length} path${dirty.length === 1 ? "" : "s"}):\n` +
          `${preview}${overflow}\n` +
          `  Commit / stash these changes first, or pass --force to override.\n`,
      );
      process.exit(2);
    }
  }

  process.stdout.write(
    `  ⬡ cairn fix align${flags.dryRun ? " --dry-run" : ""}${flags.force ? " --force" : ""} — ${repoRoot}\n\n` +
      `  pre-flight…\n`,
  );
  const args: FixAlignArgs = { repoRoot };
  if (flags.dryRun) args.dryRun = true;
  if (flags.maxCost !== null) args.maxCost = flags.maxCost;
  if (flags.include.length > 0) args.include = flags.include;
  if (flags.exclude.length > 0) args.exclude = flags.exclude;
  if (flags.skipCreation) args.skipCreation = true;

  const result = await runFixAlign(args);
  process.stdout.write(`${renderPreflight(result)}\n`);

  if (result.abortedOverBudget) {
    process.stdout.write(
      `\n  ✗ aborted — estimated tokens (${formatTokens(result.preflight.estimatedTokens)})` +
        ` exceeds --max-cost (${formatTokens(args.maxCost ?? 500_000)}).\n` +
        `  Re-run with a higher --max-cost or scope via --include / --exclude.\n`,
    );
    process.exit(2);
  }

  if (flags.dryRun) {
    // Stamp the sentinel so the next non-dry-run invocation with the
    // same flags can pass the validation gate.
    writeFixAlignSentinel(repoRoot, sentinelArgs);
    process.stdout.write(
      `\n  Dry-run complete. Re-run without --dry-run within 30 minutes to apply ` +
        `(sentinel written to .cairn/state/fix-align-dryrun.json).\n`,
    );
    process.exit(0);
  }

  process.stdout.write(`\n  apply…\n${renderApply(result)}\n`);
  process.exit(0);
}

export async function fixCli(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "Usage: cairn fix [<subcommand>] [--repo <path>] [--dry-run]\n" +
        "  No subcommand: runs the doctor auto-fix pass (rebuild ledgers,\n" +
        "                 scope-index, etc.).\n" +
        "  Subcommands:\n" +
        "    align           Layer C — full-repo Haiku-judge sweep over every\n" +
        "                    prose block × every DEC. Use --dry-run for the\n" +
        "                    pre-flight cost estimate; re-run without --dry-run\n" +
        "                    within 30 min to apply. Flags:\n" +
        "                      --max-cost <tokens>    abort if estimate exceeds\n" +
        "                                             budget (default 500k).\n" +
        "                      --include <glob>       repeatable — scope the sweep.\n" +
        "                      --exclude <glob>       repeatable — atop defaults.\n" +
        "                      --no-creation          skip Tier 3; consolidate only.\n" +
        "                      --force                bypass the dry-run sentinel +\n" +
        "                                             dirty-tree guard (CI / scripted\n" +
        "                                             contexts only).\n" +
        "                    Apply gates:\n" +
        "                      • dry-run sentinel — `--dry-run` writes\n" +
        "                        .cairn/state/fix-align-dryrun.json with HEAD SHA +\n" +
        "                        flag hash. Apply requires a fresh (≤30 min) sentinel\n" +
        "                        matching current HEAD + flags.\n" +
        "                      • dirty-tree guard — apply aborts if `git status`\n" +
        "                        reports modified / staged paths inside the include\n" +
        "                        globs (or anywhere when no --include passed).\n" +
        "  Subcommands (retroactive — for projects adopted on older versions):\n" +
        "    brand           re-run the Haiku brand-derive call against the\n" +
        "                    mapper output already on disk; rewrite the 4 brand\n" +
        "                    files. For projects adopted under v0.3.8 or earlier\n" +
        "                    where the Haiku timeout caused mechanical defaults.\n" +
        "    dec-strip       replay source-comment strip-replace for accepted\n" +
        "                    DECs whose original essay block is still in source.\n" +
        "                    For projects adopted under v0.4.0 builds before the\n" +
        "                    dirty-file overwrite fix landed.\n" +
        "    gitignore       rewrite .cairn/.gitignore from the bundled template\n" +
        "                    and `git rm --cached` newly-ignored paths. For\n" +
        "                    projects adopted before the v0.4.0 gitignore additions\n" +
        "                    (init-state.json, init/, staleness/, backups/, cache/).\n" +
        "    scrub-cache     wipe .cairn/cache/haiku/ entries. For projects adopted\n" +
        "                    before v0.4.0 ambient-context isolation; cached Haiku\n" +
        "                    responses captured user-global CLAUDE.md content and\n" +
        "                    should be re-issued under the new isolated transport.\n" +
        "    claude-rules    write .claude/rules/cairn.md so teammates whose Claude\n" +
        "                    Code lacks the Cairn plugin still see install\n" +
        "                    instructions on session start. Auto-loaded by Claude\n" +
        "                    Code regardless of plugin install state.\n" +
        "    confidence      alias for `cairn attention bulk-accept --threshold high`\n" +
        "                    which scores + stamps capture_confidence on every\n" +
        "                    draft + invariant. Run with --dry-run first.\n" +
        "    duration_ms     not implemented — phase durations are recorded\n" +
        "                    going forward (v0.4.0+); the trace doesn't carry\n" +
        "                    pre-existing phase boundaries.\n",
    );
    process.exit(0);
  }
  const sub = argv[0];
  if (sub === undefined || !RETROACTIVE_SUBCOMMANDS.has(sub)) {
    // No subcommand or unrecognized first arg — fall through to the
    // doctor auto-fix flow with the original argv (so `--repo <path>`
    // etc. still routes correctly).
    await doctorFixCli(argv);
    return;
  }
  const rest = argv.slice(1);
  const repoRoot = parseRepoFlag(rest);
  ensureAdopted(repoRoot);
  const dryRun = rest.includes("--dry-run");
  switch (sub) {
    case "align":
      await fixAlign(repoRoot, rest);
      return;
    case "brand":
      await fixBrand(repoRoot, dryRun);
      return;
    case "dec-strip":
      await fixDecStrip(repoRoot, dryRun);
      return;
    case "gitignore":
      await fixGitignore(repoRoot, dryRun);
      return;
    case "scrub-cache":
      await fixScrubCache(repoRoot, dryRun);
      return;
    case "claude-rules":
      await fixClaudeRules(repoRoot, dryRun);
      return;
    case "confidence":
      process.stdout.write(
        "  cairn fix confidence is an alias for `cairn attention bulk-accept`.\n" +
          "  Run: cairn attention bulk-accept --threshold high --dry-run\n" +
          "  to score + stamp capture_confidence without auto-accepting,\n" +
          "  then re-run without --dry-run when ready.\n",
      );
      process.exit(0);
      return;
    case "duration_ms":
      process.stdout.write(
        "  cairn fix duration_ms is not implemented.\n" +
          "  Phase durations are recorded going forward (v0.4.0+);\n" +
          "  pre-existing phase boundaries are not in the trace and cannot\n" +
          "  be retroactively backfilled.\n",
      );
      process.exit(0);
      return;
  }
}
