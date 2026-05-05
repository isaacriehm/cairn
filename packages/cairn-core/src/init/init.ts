/**
 * `cairn init` orchestrator — full guided adoption.
 *
 * Stages:
 *   1. Detect → print summary
 *   2. Proceed dialog (cancel exits cleanly, no writes)
 *   3. Seed `.cairn/` + `.archive/` from templates with `<project_name>`
 *      substituted; write `.cairn/config.yaml` (including `cairn_version`).
 *   4. Mapper (Tier-2 chunked Sonnet) → seed `<slug>:` workflow.md block +
 *      `.cairn/config.yaml` project_globs.
 *   5. Brand setup (4-question wizard).
 *   6. Phase 6 docs ingestion + baseline sensor sweep.
 *   7. Phase 7b source-comment ingestion + 7c rules merge (mock-friendly
 *      via `mockSourceCommentClassify` / `mockRulesMergeClassify`).
 *   8. Phase 12 multi-dev install (deterministic, idempotent).
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { VERSION } from "../index.js";
import {
  scopeIndexPath,
  writeScopeIndex,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "../ground/scope-index.js";
import { normalizeProjectName } from "../paths/index.js";
import { homedir } from "node:os";
import { logger, setLogFile } from "../logger.js";
import {
  applyBrandAnswers,
  runBrandSetup,
  type BrandAnswers,
} from "./brand-setup.js";
import {
  defaultBaselineLanguages,
  runBaselineAudit,
  type BaselineAuditResult,
} from "./baseline-audit.js";
import {
  runDocsIngestion,
  type IngestionResult,
} from "./ingest-docs.js";
import {
  runSourceCommentsIngestion,
  type CommentClassification,
  type IngestSourceCommentsResult,
} from "./source-comments/index.js";
import {
  runRulesMerge,
  type RuleClassification,
  type RunRulesMergeResult,
} from "./rules-merge/index.js";
import {
  installMultiDev,
  type MultiDevInstallResult,
} from "./multi-dev/index.js";
import type { CommentBlock } from "./source-comments/walker.js";
import type { RuleSection, RuleSourceFile } from "./rules-merge/index.js";
import {
  detectMonorepoContext,
  findGitRoot,
  isCairnSourceRepo,
  type MonorepoContext,
} from "./preflight-guards.js";
import { detectAll } from "./detect.js";
import {
  runGitSubmoduleUpdate,
  scanSubmodules,
  type SubmoduleInfo,
} from "./submodules.js";
import {
  c as visualC,
  discoveryRow,
  installInitCancelHandlers,
  startSpinner,
} from "./visual.js";
import {
  runMapper,
  validateMapperOutput,
  type MapperOutput,
  type MapperResult,
} from "./mapper.js";
import {
  done,
  freeTextWithDefault,
  header,
  info,
  squareIntoSquareHole,
  yesNo,
  type PromptMode,
} from "./prompts.js";
import { seedCairnLayout } from "./seed.js";
import type { DetectionResult } from "./types.js";
import { buildProjectOverlay } from "./overlay.js";
import { buildRepoSummary, type RepoSummary } from "./walker.js";
import { updateWorkflowSlugBlock } from "./workflow-block.js";

const log = logger("init");

export interface RunInitArgs {
  /** Repo root the operator wants to adopt. Default = process.cwd(). */
  repoRoot?: string;
  /** Override the detected slug. Useful for `cairn init . --slug foo`. */
  slugOverride?: string;
  /** auto = no prompts (smoke / scripted adoption). interactive = real wizard. */
  mode?: PromptMode;
  /** Force-overwrite existing `.cairn/` files. Default false. */
  force?: boolean;
  /** Auto-pick proceed? when mode=auto. */
  autoProceed?: "a" | "b";
  /** Skip guided setup — smoke convenience. */
  skipGuidedSetup?: boolean;
  /** Skip the Tier-2 init mapper. Default off in interactive mode (we run the
   * mapper unless operator declines or claude is missing); always off in auto
   * mode unless `mockMapperOutput` is provided. */
  skipMapper?: boolean;
  /**
   * Substitute a canned MapperOutput for the LLM call. Used by smokes and any
   * scripted adoption path that wants to exercise the apply-to-config and
   * apply-to-workflow.md path without burning Sonnet tokens.
   */
  mockMapperOutput?: MapperOutput;
  /**
   * Skip the interactive 4-question brand setup (Phase 5b). Smokes / auto
   * mode set this; interactive runs default to running it.
   */
  skipBrandSetup?: boolean;
  /** Pre-canned brand answers — exercises the apply path without a TTY. */
  scriptedBrandAnswers?: Partial<BrandAnswers>;
  /**
   * Skip the submodule detection + init prompt (Phase 1). Smokes set this so
   * temp dir fixtures don't trip on git submodule lookups.
   */
  skipSubmoduleCheck?: boolean;
  /**
   * Skip Phase 6 — docs ingestion + baseline sensor sweep. Smokes default to
   * skipping since the Haiku ingestion call costs tokens; production runs
   * default to running.
   */
  skipIngestion?: boolean;
  /**
   * When mode === "auto", how to answer the submodule init prompt.
   *   "init"  — run `git submodule update --init --recursive`
   *   "skip"  — leave uninitialized, accept partial mapper visibility
   * Default `"init"` matches the interactive default.
   */
  autoSubmodule?: "init" | "skip";
  /**
   * Skip the self-adoption hard-stop (Phase -1). Smokes set this so they
   * can run init against the cairn source repo for development.
   */
  skipSelfAdoptionGuard?: boolean;
  /**
   * Skip the monorepo-subdir warning (Phase 0a). Smokes set this so they
   * don't trip on running from a temp dir nested under a workspace.
   */
  skipMonorepoGuard?: boolean;
  /**
   * When mode === "auto", how to answer the monorepo-subdir prompt.
   *   "continue" — proceed with cwd-scoped init (the unsafe choice)
   *   "abort"    — exit without writing anything (the default)
   */
  autoMonorepo?: "continue" | "abort";
  /**
   * Skip Phase 7b — full-repo source-comment ingestion. Defaults to the
   * same gate as `skipIngestion`. Tests pass `mockSourceCommentClassify`
   * to exercise the persistence path without burning Haiku tokens.
   */
  skipPhase7b?: boolean;
  /**
   * Skip Phase 7c — existing-rules merge + initial CLAUDE.md/AGENTS.md
   * regeneration. Defaults to the same gate as `skipIngestion`. Tests
   * pass `mockRulesMergeClassify` to bypass Haiku.
   */
  skipPhase7c?: boolean;
  /**
   * Skip Phase 12 — multi-dev enforcement install (package.json prepare,
   * non-Node manual hints). Defaults to false; auto mode runs Phase 12
   * since it's purely deterministic + idempotent.
   */
  skipPhase12?: boolean;
  /**
   * Test override for the source-comment classifier. When set, Phase 7b
   * runs without any Haiku call.
   */
  mockSourceCommentClassify?: (block: CommentBlock) => CommentClassification;
  /**
   * Test override for the rules-merge classifier. When set, Phase 7c
   * runs without any Haiku call.
   */
  mockRulesMergeClassify?: (
    section: RuleSection,
    source: RuleSourceFile,
  ) => RuleClassification;
}

export interface InitResult {
  detection: DetectionResult;
  decided_slug: string;
  proceed: boolean;
  seeded_files: string[];
  collisions: string[];
  config_path: string;
  /** Mapper outcome — null when skipped/failed, full output when applied. */
  mapper_output: MapperOutput | null;
  /** Whether mapper output reached the workflow.md slug block. */
  mapper_applied_to_workflow: boolean;
  /** Whether mapper output reached the new .cairn/config.yaml. */
  mapper_applied_to_config: boolean;
  /** Brand-setup outcome (Phase 5b). null when skipped. */
  brand_setup: {
    answered: number;
    updated_files: string[];
  } | null;
  /** Phase 6 ingestion outcome (docs → DEC drafts, canonical-map seed). */
  ingestion: IngestionResult | null;
  /** Phase 6 baseline sensor audit outcome. */
  baseline_audit: BaselineAuditResult | null;
  /** Phase 7b — full-repo source-comment ingestion. */
  source_comments: IngestSourceCommentsResult | null;
  /** Phase 7c — existing-rules merge result. */
  rules_merge: RunRulesMergeResult | null;
  /** Phase 12 — multi-dev enforcement install result. */
  multi_dev: MultiDevInstallResult | null;
  /** Absolute path to the log file pino output was redirected to. */
  log_file_path: string | null;
  /** Monorepo subdir context if init was launched from a sub-package. */
  monorepo_context: MonorepoContext | null;
  /** Submodule check outcome (Phase 1). null when skipped or no .gitmodules. */
  submodules: {
    /** Submodule paths that were uninitialized when init started. */
    detected_uninitialized: string[];
    /** True when the operator opted to run `git submodule update`. */
    initialized: boolean;
    /** True when the init succeeded; false when skipped or failed. */
    success: boolean;
  } | null;
  warnings: string[];
}

// DEFAULT_OFF_LIMITS + buildProjectOverlay live in ./overlay.js so the
// MCP-native phase pipeline (phases/3b-seed.ts) can call them too.

export async function runInit(args: RunInitArgs = {}): Promise<InitResult> {
  const repoRoot = args.repoRoot ?? process.cwd();
  const cwd = process.cwd();
  const mode: PromptMode = args.mode ?? "interactive";
  const warnings: string[] = [];

  // ── Phase -1: self-adoption hard stop ──────────────────────────────
  // If repoRoot or cwd looks like the Cairn source repo itself, refuse —
  // running init here would overwrite cairn internals.
  if (args.skipSelfAdoptionGuard !== true) {
    if (isCairnSourceRepo(repoRoot) || isCairnSourceRepo(cwd)) {
      info("");
      info("  ✗  This looks like the Cairn source repository.");
      info("     Running init here would overwrite cairn internals.");
      info("");
      info("  cairn init is for projects that USE Cairn, not for Cairn itself.");
      info("  If you're developing Cairn, you don't need to run init.");
      info("");
      process.exit(1);
    }
  }

  // ── Phase 0: install cancel handlers + redirect pino logs to a file.
  // Cancel handlers are interactive-only; auto mode (smokes) skips them so
  // the SIGINT trap doesn't keep the test process alive.
  if (mode === "interactive") {
    installInitCancelHandlers();
  }
  const logFilePath = redirectInitLogs();

  header(`Cairn init — ${repoRoot}`);

  if (!existsSync(join(repoRoot, ".git"))) {
    warnings.push(
      "no .git directory — mirror init will be skipped; the cairn expects a git-tracked working tree",
    );
  }

  // ── Phase 0a: monorepo subdir guard ────────────────────────────────
  // Walk cwd → gitRoot looking for a workspace marker. If cwd is inside a
  // monorepo PACKAGE rather than at the workspace root, the mapper would
  // only see the package subtree — usually not what the operator wants.
  const monorepoContext = await preflightMonorepoGuard({
    cwd,
    repoRoot,
    mode,
    skip: args.skipMonorepoGuard === true,
    autoMonorepo: args.autoMonorepo ?? "abort",
    warnings,
  });

  // ── Phase 1: submodule pre-flight ──────────────────────────────────
  const submoduleSummary = await preflightSubmodules({
    repoRoot,
    mode,
    skip: args.skipSubmoduleCheck === true,
    autoSubmodule: args.autoSubmodule ?? "init",
    warnings,
  });

  const detection = await detectAll(repoRoot);
  const decidedSlug =
    args.slugOverride !== undefined
      ? normalizeProjectName(args.slugOverride)
      : detection.project_slug;
  // Walk repo here so the scan row appears in the Phase-1 discovery output.
  // The same summary feeds the mapper later — no re-walk.
  const repoSummary = buildRepoSummary({ repoRoot });
  if (repoSummary.truncated_at_file_cap) {
    warnings.push(
      "repo walk truncated at file cap — pilot scope will be conservative",
    );
  }
  if (repoSummary.truncated_at_depth_cap) {
    warnings.push("repo walk truncated at depth cap");
  }
  printDiscovery(detection, decidedSlug, warnings, repoSummary);

  // ── Dialog 1 (legacy proceed?) — only fired in auto mode for smoke compat.
  // Interactive runs skip the explicit confirm per INIT_SPEC.md §3 (single
  // confirm). The pilot-module prompt at the end of mapper proposal is the
  // single operator gate.
  const proceedChoice =
    mode === "auto"
      ? args.autoProceed ?? "a"
      : "a";
  if (proceedChoice === "b") {
    info("\ncancelled — no files written.");
    return {
      detection,
      decided_slug: decidedSlug,
      proceed: false,
      seeded_files: [],
      collisions: [],
      config_path: "",
      mapper_output: null,
      mapper_applied_to_workflow: false,
      mapper_applied_to_config: false,
      brand_setup: null,
      ingestion: null,
      baseline_audit: null,
      source_comments: null,
      rules_merge: null,
      multi_dev: null,
      log_file_path: logFilePath,
      monorepo_context: monorepoContext,
      submodules: submoduleSummary,
      warnings,
    };
  }

  // ── Prerequisite state — derived from the discovery scan only. The
  // pre-visual-overhaul "Guided setup" section that re-printed ✓ rows for
  // each prereq was removed — the scanning section above is the sole place
  // those checks appear.
  const envState = detection.environment;

  // ── Init mapper (Tier 2 / Sonnet) — proposes pilot_module + project_globs.
  // Without this, project_globs.{route_handler,dto,generator_source,high_stakes}
  // sit empty and Layer-D sensors never fire on real diffs (rework brief §3.1).
  const mapperRunResult = await maybeRunMapper({
    repoRoot,
    detection,
    repoSummary,
    mode,
    skipMapper: args.skipMapper === true,
    ...(args.mockMapperOutput !== undefined
      ? { mockMapperOutput: args.mockMapperOutput }
      : {}),
    envClaudeAuth: envState.claude_auth,
    warnings,
  });
  const mapperOutput: MapperOutput | null =
    mapperRunResult === null ? null : mapperRunResult.output;
  const mapperFallbackSlugs: string[] =
    mapperRunResult === null ? [] : mapperRunResult.fallbackSlugs;

  // ── Step 2: seed templates ─────────────────────────────────────────
  header("Seeding .cairn/ + .archive/");
  const seed = seedCairnLayout({
    repoRoot,
    projectSlug: decidedSlug,
    ...(args.force === true ? { force: true } : {}),
  });
  for (const f of seed.written_files) done(`+ ${f}`);
  for (const c of seed.collisions) {
    warnings.push(`collision (kept existing): ${c}`);
    done(`= ${c}  (kept existing — pass --force to overwrite)`);
  }

  // ── Step 2b: apply mapper output to workflow.md `<slug>:` block.
  // Only when workflow.md was just seeded (or --force re-seeded). Re-runs that
  // kept the existing workflow.md skip this so operator edits aren't clobbered.
  const wfRelPath = ".cairn/config/workflow.md";
  const wfWasSeeded = seed.written_files.includes(wfRelPath);
  let mapperAppliedToWorkflow = false;
  if (mapperOutput !== null && wfWasSeeded) {
    const wfPath = join(repoRoot, wfRelPath);
    try {
      const r = updateWorkflowSlugBlock({
        workflowMdPath: wfPath,
        slug: decidedSlug,
        update: {
          pilot_module: mapperOutput.pilot_module,
          route_handler_globs: mapperOutput.route_handler_globs,
          dto_globs: mapperOutput.dto_globs,
          generator_source_globs: mapperOutput.generator_source_globs,
          high_stakes_globs: mapperOutput.high_stakes_globs,
          off_limits_append: mapperOutput.off_limits_globs,
        },
      });
      done(
        `+ patched <${decidedSlug}>: block in ${wfRelPath} (${r.applied_keys.join(", ")}; +${r.off_limits_added.length} off-limits)`,
      );
      mapperAppliedToWorkflow = true;
    } catch (err) {
      warnings.push(`workflow.md slug-block update failed: ${String(err)}`);
    }
  } else if (mapperOutput !== null && !wfWasSeeded) {
    warnings.push(
      `mapper output NOT applied to ${wfRelPath} — kept existing; re-run with --force to overwrite, or merge globs manually`,
    );
  }

  // ── Step 3: write project-overlay config.yaml ──────────────────────
  header("Writing .cairn/config.yaml");
  const configPath = join(repoRoot, ".cairn", "config.yaml");
  mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
  let mapperAppliedToConfig = false;
  if (existsSync(configPath) && args.force !== true) {
    warnings.push(`.cairn/config.yaml already exists — kept existing (use --force to overwrite)`);
    done(`= .cairn/config.yaml (kept)`);
    if (mapperOutput !== null) {
      warnings.push(
        `mapper output NOT applied to .cairn/config.yaml — kept existing; project_globs may be stale`,
      );
    }
  } else {
    const config = buildProjectOverlay({
      detection,
      decidedSlug,
      ...(mapperOutput !== null ? { mapperOutput } : {}),
    });
    writeFileSync(configPath, stringifyYaml(config), "utf8");
    done(`+ .cairn/config.yaml`);
    if (mapperOutput !== null) mapperAppliedToConfig = true;
  }

  // ── Step 3b: scope-index.yaml ──────────────────────────────────────
  header("Writing .cairn/ground/scope-index.yaml");
  const scopeIndexFile = scopeIndexPath(repoRoot);
  if (existsSync(scopeIndexFile) && args.force !== true) {
    warnings.push(
      ".cairn/ground/scope-index.yaml already exists — kept existing (use --force to overwrite)",
    );
    done(`= .cairn/ground/scope-index.yaml (kept)`);
  } else {
    const seedFiles: Record<string, ScopeIndexEntry> = {};
    const mapperFiles = mapperOutput?.scope_index?.files ?? {};
    for (const [path, e] of Object.entries(mapperFiles)) {
      const entry: ScopeIndexEntry = {
        decisions: e.decisions,
        invariants: e.invariants,
      };
      if (e.unscoped === true) entry.unscoped = true;
      seedFiles[path] = entry;
    }
    const seed: ScopeIndex = {
      generated: new Date().toISOString(),
      files: seedFiles,
    };
    writeScopeIndex(repoRoot, seed);
    done(`+ .cairn/ground/scope-index.yaml`);
  }

  // ── Step 5b: brand setup (interactive 4-question wizard) ───────────
  let brandSetup: { answered: number; updated_files: string[] } | null = null;
  if (args.skipBrandSetup !== true) {
    const answers = await runBrandSetup({
      projectName: decidedSlug,
      ...(mode === "auto" ? { skip: true } : {}),
      ...(args.scriptedBrandAnswers !== undefined
        ? { scriptedAnswers: args.scriptedBrandAnswers }
        : {}),
    });
    const answered =
      (answers.whatItDoes.length > 0 ? 1 : 0) +
      (answers.mainUsers.length > 0 ? 1 : 0) +
      (answers.voice.length > 0 ? 1 : 0) +
      (answers.avoid.length > 0 ? 1 : 0);
    if (answered > 0) {
      const apply = applyBrandAnswers(repoRoot, answers);
      for (const w of apply.warnings) warnings.push(w);
      brandSetup = { answered, updated_files: apply.updated };
    } else {
      brandSetup = { answered: 0, updated_files: [] };
    }
  }

  // ── Phase 6: ingestion sweep + baseline audit ──────────────────────
  // Populates project brain from docs that already exist in the repo, then
  // runs every runnable sensor against the full codebase to surface pre-
  // Cairn debt. Both pieces are best-effort; failures degrade to empty
  // result, never block the init.
  const phase6 = await runPhaseSix({
    repoRoot,
    decidedSlug,
    detection,
    mapperOutput,
    skip: args.skipIngestion === true || mode === "auto",
    warnings,
  });

  // ── Phase 7b: source-comment ingestion ─────────────────────────────
  // Walks every source file, batches block-comments through Haiku, files
  // DEC drafts + invariant proposals + canonical citations into
  // `.cairn/baseline/`. Skipped under the same condition as Phase 6
  // unless a `mockSourceCommentClassify` is supplied (smokes).
  let sourceComments: IngestSourceCommentsResult | null = null;
  const skip7b =
    args.skipPhase7b === true ||
    ((args.skipIngestion === true || mode === "auto") &&
      args.mockSourceCommentClassify === undefined);
  if (!skip7b) {
    process.stdout.write("\n");
    process.stdout.write(
      `  ${visualC.bold("Phase 7b")} — source-comment ingestion…\n`,
    );
    try {
      sourceComments = await runSourceCommentsIngestion({
        repoRoot,
        ...(args.mockSourceCommentClassify !== undefined
          ? { mockClassify: args.mockSourceCommentClassify }
          : {}),
        onBatchProgress: (row) => {
          if (row.index === row.total - 1) {
            process.stdout.write(
              `    ${row.classified} classified, ${row.failed} failed (${row.total} batch${row.total === 1 ? "" : "es"})\n`,
            );
          }
        },
      });
      process.stdout.write(
        `    DEC drafts: ${sourceComments.decDraftsWritten.length}; ` +
          `invariant proposals: ${sourceComments.invariantProposalsAdded}; ` +
          `citations: ${sourceComments.canonicalCitationsAdded}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`source-comment ingestion failed: ${msg}`);
      process.stdout.write(
        `    ${visualC.yellow("⚠")} source-comment ingestion failed — ${msg}\n`,
      );
    }
  }

  // ── Phase 7c: existing-rules merge + first regenerate ──────────────
  // Reads CLAUDE.md / AGENTS.md / .claude/CLAUDE.md / .claude/rules/**.md,
  // classifies sections via Haiku into rule-net-new / rule-conflict /
  // informational / operator-keep, persists net-new as DEC drafts. The
  // initial regenerate of CLAUDE.md + AGENTS.md from ground state is
  // deferred until after operator accepts the drafts in the attention
  // pass — we don't auto-overwrite their existing rule files at adoption.
  let rulesMerge: RunRulesMergeResult | null = null;
  const skip7c =
    args.skipPhase7c === true ||
    ((args.skipIngestion === true || mode === "auto") &&
      args.mockRulesMergeClassify === undefined);
  if (!skip7c) {
    process.stdout.write("\n");
    process.stdout.write(
      `  ${visualC.bold("Phase 7c")} — existing-rules merge…\n`,
    );
    try {
      rulesMerge = await runRulesMerge({
        repoRoot,
        ...(args.mockRulesMergeClassify !== undefined
          ? { mockClassify: args.mockRulesMergeClassify }
          : {}),
      });
      process.stdout.write(
        `    Sources: ${rulesMerge.sources.length}; ` +
          `net-new: ${rulesMerge.kindCounts["rule-net-new"]}; ` +
          `conflicts: ${rulesMerge.kindCounts["rule-conflict"]}; ` +
          `informational: ${rulesMerge.kindCounts.informational}; ` +
          `operator-keep: ${rulesMerge.kindCounts["operator-keep"]}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`rules merge failed: ${msg}`);
      process.stdout.write(
        `    ${visualC.yellow("⚠")} rules merge failed — ${msg}\n`,
      );
    }
  }

  // ── Phase 12: multi-developer enforcement install ──────────────────
  // Idempotent + deterministic. Patches `package.json` `scripts.prepare`
  // for Node projects so every clone runs `cairn join` on install.
  // Surfaces manual hints for non-Node hosts. Templates (.cairn/
  // git-hooks/*, JOIN.md, .github/workflows/cairn-check.yml) were
  // landed by `seedCairnLayout` in Phase 4.
  let multiDev: MultiDevInstallResult | null = null;
  if (args.skipPhase12 !== true) {
    process.stdout.write("\n");
    process.stdout.write(
      `  ${visualC.bold("Phase 12")} — multi-dev enforcement install…\n`,
    );
    try {
      multiDev = installMultiDev({ repoRoot });
      const hostList = multiDev.hostKinds.join(", ");
      process.stdout.write(
        `    Hosts detected: ${hostList}; prepare patched: ${multiDev.preparePatched ? "yes" : "no"}\n`,
      );
      for (const hint of multiDev.manualHints) {
        process.stdout.write(`    ${visualC.dim(hint)}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`multi-dev install failed: ${msg}`);
      process.stdout.write(
        `    ${visualC.yellow("⚠")} multi-dev install failed — ${msg}\n`,
      );
    }
  }

  // Per-session status.json is owned by the plugin's SessionStart hook
  // (PLUGIN_ARCHITECTURE §7). Init no longer writes it; the next
  // SessionStart in any clone seeds the per-session file with the
  // current attention_count derived from drafts + baseline findings.

  // ── Step 6: completion summary (structured) ────────────────────────
  printCompletionSummary({
    projectName: decidedSlug,
    repoRoot,
    seededFiles: seed.written_files,
    brandSetup,
    submodules: submoduleSummary,
    scanTruncated:
      repoSummary.truncated_at_file_cap ||
      repoSummary.truncated_at_depth_cap,
    mapperFallbackSlugs,
    ingestion: phase6.ingestion,
    baselineAudit: phase6.baselineAudit,
    logFilePath,
    warnings,
  });

  log.info(
    {
      repo_root: repoRoot,
      slug: decidedSlug,
      seeded: seed.written_files.length,
      collisions: seed.collisions.length,
      mapper_ran: mapperOutput !== null,
      mapper_applied_to_workflow: mapperAppliedToWorkflow,
      mapper_applied_to_config: mapperAppliedToConfig,
      brand_answered: brandSetup?.answered ?? null,
      ingestion_drafts: phase6.ingestion?.decDraftsWritten.length ?? null,
      baseline_findings: phase6.baselineAudit?.totalFindings ?? null,
      warnings: warnings.length,
    },
    "init complete",
  );

  return {
    detection,
    decided_slug: decidedSlug,
    proceed: true,
    seeded_files: seed.written_files,
    collisions: seed.collisions,
    config_path: ".cairn/config.yaml",
    mapper_output: mapperOutput,
    mapper_applied_to_workflow: mapperAppliedToWorkflow,
    mapper_applied_to_config: mapperAppliedToConfig,
    brand_setup: brandSetup,
    ingestion: phase6.ingestion,
    baseline_audit: phase6.baselineAudit,
    source_comments: sourceComments,
    rules_merge: rulesMerge,
    multi_dev: multiDev,
    log_file_path: logFilePath,
    monorepo_context: monorepoContext,
    submodules: submoduleSummary,
    warnings,
  };
}


interface MaybeRunMapperArgs {
  repoRoot: string;
  detection: DetectionResult;
  repoSummary: RepoSummary;
  mode: PromptMode;
  skipMapper: boolean;
  mockMapperOutput?: MapperOutput;
  envClaudeAuth: boolean;
  warnings: string[];
}

interface MaybeRunMapperResult {
  output: MapperOutput;
  /** Module slugs whose Sonnet call failed and used the heuristic fallback. */
  fallbackSlugs: string[];
}

async function maybeRunMapper(
  args: MaybeRunMapperArgs,
): Promise<MaybeRunMapperResult | null> {
  if (args.mockMapperOutput !== undefined) {
    info("\n── Init mapper — using injected mockMapperOutput (smoke / scripted adoption)");
    return { output: args.mockMapperOutput, fallbackSlugs: [] };
  }
  if (args.skipMapper) {
    info("\n── Init mapper skipped (--skip-mapper); project_globs left empty");
    args.warnings.push("mapper skipped via --skip-mapper — project_globs left empty");
    return null;
  }
  if (args.mode === "auto") {
    info(
      "\n── Init mapper skipped (--no-prompt mode; pass mockMapperOutput to test the apply path)",
    );
    return null;
  }
  if (!args.envClaudeAuth) {
    args.warnings.push(
      "mapper skipped — claude CLI not available; project_globs left empty",
    );
    info(
      "\n── Init mapper skipped — claude CLI not available; re-run init after `claude` auth to fill project_globs",
    );
    return null;
  }

  // Reuse the summary built during Phase-1 discovery — no second walk.
  const summary = args.repoSummary;

  // Mapper dispatches automatically per INIT_SPEC §3 — no per-run cost prompt.
  // The orchestrator handles parallel module calls + Haiku merge internally;
  // legacy single-call path is its own fallback when every module call fails.
  let mapperResult: MapperResult;
  const spinner = startSpinner("Analyzing codebase…");
  let totalSlices = 0;
  let completed = 0;
  let failedModules = 0;
  const t0 = Date.now();
  try {
    mapperResult = await runMapper({
      detection: args.detection,
      summary,
      repoRoot: args.repoRoot,
      onSlicesDetected: (slices) => {
        totalSlices = slices.length;
        spinner.update(
          totalSlices === 1
            ? `Analyzing codebase (1 module)…`
            : `Analyzing codebase (${totalSlices} modules)…`,
        );
      },
      onModuleEnd: (slice, p) => {
        completed++;
        if (p.failed) failedModules++;
        const mark = p.failed ? "✗" : "✓";
        const dur = `${(p.durationMs / 1000).toFixed(0)}s`;
        spinner.update(
          `Analyzing codebase (${completed}/${totalSlices}) — ${mark} ${slice.moduleSlug} ${dur}`,
        );
      },
    });
    const ms = Date.now() - t0;
    const seconds = `${(ms / 1000).toFixed(0)}s`;
    if (failedModules > 0) {
      spinner.succeed(
        `Analysis complete (${seconds} · ${completed - failedModules}/${totalSlices} modules ok)`,
      );
    } else {
      spinner.succeed(
        `Analysis complete (${seconds} · ${completed} module${completed === 1 ? "" : "s"})`,
      );
    }
  } catch (err) {
    spinner.fail(
      `Analysis failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    args.warnings.push(`mapper dispatch failed: ${String(err)}`);
    return null;
  }
  printMapperProposal(mapperResult);

  // Single confirm — pilot module. Operator presses Enter to apply or types
  // an alternate path to override. (args.mode narrowed to "interactive" above.)
  const pilotChoice = await freeTextWithDefault({
    mode: args.mode,
    prompt: "Press Enter to apply, or type a different pilot path",
    defaultValue: mapperResult.output.pilot_module,
  });
  if (pilotChoice.length > 0 && pilotChoice !== mapperResult.output.pilot_module) {
    mapperResult.output.pilot_module = pilotChoice;
  }
  const fallbackSlugs =
    mapperResult.module_proposals === undefined
      ? []
      : mapperResult.module_proposals.filter((p) => p.failed).map((p) => p.moduleSlug);
  if (fallbackSlugs.length > 0) {
    args.warnings.push(
      `mapper fallback used for: ${fallbackSlugs.join(", ")} — rerun \`cairn scope rebuild\` for full classification`,
    );
  }
  return { output: mapperResult.output, fallbackSlugs };
}

function printMapperProposal(
  r: MapperResult,
  opts: { partialModules?: string[] } = {},
): void {
  const o = r.output;
  process.stdout.write("\n");
  // Project line: slug — domain summary (truncated)
  const projectName = "(detected)";
  process.stdout.write(
    `  ${visualC.bold("Project")}    ${projectName} — ${truncateOneLine(o.domain_summary, 100)}\n`,
  );
  process.stdout.write("\n");
  // Modules line: dot-separated module names
  const moduleLabels = o.key_modules.map((km) => km.path);
  if (moduleLabels.length > 0) {
    process.stdout.write(
      `  ${visualC.bold("Modules")}    ${moduleLabels.join("  ·  ")}\n`,
    );
    process.stdout.write("\n");
  }
  // Sensors block
  const sensors = o.proposed_sensors;
  if (sensors.length > 0) {
    const headLine = `${sensors.length} proposed`;
    process.stdout.write(`  ${visualC.bold("Sensors")}    ${headLine}\n`);
    const widest = Math.max(...sensors.slice(0, 3).map((s) => s.id.length), 1);
    for (const s of sensors.slice(0, 3)) {
      process.stdout.write(
        `             ${s.id.padEnd(widest + 2)}${truncateOneLine(s.description, 80 - widest)}\n`,
      );
    }
    if (sensors.length > 3) {
      process.stdout.write(
        `             ${visualC.dim(`+ ${sensors.length - 3} more`)}\n`,
      );
    }
    process.stdout.write("\n");
  }
  // Pilot line
  const pilotNote =
    opts.partialModules !== undefined && opts.partialModules.length > 0
      ? `  ${visualC.dim(`(only fully-visible module — run cairn scope rebuild after submodules initialize)`)}`
      : "";
  process.stdout.write(`  ${visualC.bold("Pilot")}      ${o.pilot_module}${pilotNote}\n`);
}

function truncateOneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function redirectInitLogs(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const path = join(
    homedir(),
    ".local",
    "cairn",
    "logs",
    `init-${stamp}.log`,
  );
  try {
    setLogFile(path);
    return path;
  } catch {
    // best-effort — falls through to whatever the default destination is.
    return path;
  }
}

interface PreflightMonorepoGuardArgs {
  cwd: string;
  repoRoot: string;
  mode: PromptMode;
  skip: boolean;
  autoMonorepo: "continue" | "abort";
  warnings: string[];
}

async function preflightMonorepoGuard(
  args: PreflightMonorepoGuardArgs,
): Promise<MonorepoContext | null> {
  if (args.skip) return null;
  // The guard applies only when the operator launched init at their cwd.
  // When a different repoRoot is targeted (`--repo <path>`, smokes), the
  // process.cwd() relationship to the workspace is irrelevant.
  if (args.repoRoot !== args.cwd) return null;

  const gitRoot = findGitRoot(args.cwd);
  if (gitRoot === null) return null;
  const ctx = detectMonorepoContext(args.cwd, gitRoot);
  if (ctx === null) return null;

  const relScope = relative(ctx.workspaceRoot, args.cwd) || ".";
  info("");
  info(`  ${visualC.yellow("⚠")}  You're inside a monorepo package.`);
  info(
    `     init from here will only analyse: ${visualC.bold(relScope + "/")}`,
  );
  info(
    `     Monorepo root detected at:        ${visualC.dim(ctx.workspaceRoot)}`,
  );
  info("");
  info("  Run from the monorepo root for full codebase analysis.");

  const choice =
    args.mode === "auto"
      ? args.autoMonorepo === "continue"
      : await yesNo({
          mode: args.mode,
          prompt: "Continue here anyway? (not recommended)",
          defaultYes: false,
        });

  if (!choice) {
    info("");
    info(`  Aborted. To run from the workspace root:`);
    info(`    cd ${ctx.workspaceRoot} && cairn init`);
    info("");
    process.exit(1);
  }

  args.warnings.push(
    `init ran from a monorepo sub-package (scope=${relScope}); workspace root at ${ctx.workspaceRoot} was bypassed. Re-run from there for full codebase analysis.`,
  );
  return ctx;
}

interface PreflightSubmodulesArgs {
  repoRoot: string;
  mode: PromptMode;
  skip: boolean;
  autoSubmodule: "init" | "skip";
  warnings: string[];
}

type SubmoduleSummary = NonNullable<InitResult["submodules"]>;

async function preflightSubmodules(
  args: PreflightSubmodulesArgs,
): Promise<SubmoduleSummary | null> {
  if (args.skip) return null;
  const scan = await scanSubmodules(args.repoRoot);
  if (!scan.hasGitmodules) return null;

  const uninitialized: SubmoduleInfo[] = scan.submodules.filter(
    (s) => s.uninitialized,
  );
  if (uninitialized.length === 0) {
    // All submodules already initialized — no prompt, no warning.
    return {
      detected_uninitialized: [],
      initialized: false,
      success: true,
    };
  }

  info("");
  info("Git submodules detected — not initialized");
  const widest = Math.max(
    ...uninitialized.map((s) => s.path.length),
    1,
  );
  for (const s of uninitialized) {
    info(`  ${s.path.padEnd(widest + 2)}(uninitialized)`);
  }
  info("");

  const initFlag =
    args.mode === "auto"
      ? args.autoSubmodule !== "skip"
      : await yesNo({
          mode: args.mode,
          prompt: "Initialize submodules now? Required for full codebase analysis.",
          defaultYes: true,
        });

  if (!initFlag) {
    args.warnings.push(
      `submodules left uninitialized — mapper has partial visibility on: ${uninitialized
        .map((s) => s.path)
        .join(", ")}. Re-run \`git submodule update --init --recursive\` then \`cairn scope rebuild\`.`,
    );
    info(`  ⚠ submodule init skipped — mapper will see partial codebase`);
    return {
      detected_uninitialized: uninitialized.map((s) => s.path),
      initialized: false,
      success: false,
    };
  }

  info("  ↻ initializing submodules…");
  const result = await runGitSubmoduleUpdate({
    repoRoot: args.repoRoot,
    onProgress: (event) => {
      const m = event.line.match(/Submodule path '([^']+)':/);
      if (m && typeof m[1] === "string") {
        info(`    ✓ ${m[1]}`);
      }
    },
  });
  if (!result.ok) {
    args.warnings.push(
      `submodule init failed (${result.errorSummary ?? "unknown"}) — mapper has partial visibility. Re-run \`git submodule update --init --recursive\` manually then \`cairn scope rebuild\`.`,
    );
    info(`  ✗ submodule init failed — continuing with partial codebase`);
    return {
      detected_uninitialized: uninitialized.map((s) => s.path),
      initialized: true,
      success: false,
    };
  }
  info("  ✓ submodules ready");
  return {
    detected_uninitialized: uninitialized.map((s) => s.path),
    initialized: true,
    success: true,
  };
}

interface CompletionSummaryArgs {
  projectName: string;
  repoRoot: string;
  seededFiles: string[];
  brandSetup: { answered: number; updated_files: string[] } | null;
  submodules: SubmoduleSummary | null;
  /** True when the Phase-1 walker hit a file or depth cap. */
  scanTruncated: boolean;
  /** Module slugs that used the heuristic fallback path; empty when none. */
  mapperFallbackSlugs: string[];
  /** Phase 6 ingestion outcome — null when ingestion was skipped. */
  ingestion: IngestionResult | null;
  /** Phase 6 baseline audit outcome — null when ingestion was skipped. */
  baselineAudit: BaselineAuditResult | null;
  logFilePath: string | null;
  warnings: string[];
}

function printCompletionSummary(args: CompletionSummaryArgs): void {
  const groundCount = countGroundFiles(args.repoRoot);
  const sensorCount = countSensorEntries(args.repoRoot);
  const scopeReport = describeScopeIndex(
    args.repoRoot,
    args.submodules,
    args.scanTruncated,
  );
  const brandReport = describeBrandStatus(args.repoRoot);
  const mcpReport = describeMcpRegistration(args.repoRoot);

  info("");
  info(`  ✓ Cairn ready — ${args.projectName}`);
  info("");
  info(`  Ground state      .cairn/ground/ (${groundCount} files)`);
  info(`  MCP server        ${mcpReport}`);
  info(`  Sensors           ${sensorCount} active`);
  if (args.mapperFallbackSlugs.length > 0) {
    const head = args.mapperFallbackSlugs.slice(0, 3).join(", ");
    const more =
      args.mapperFallbackSlugs.length > 3
        ? ` +${args.mapperFallbackSlugs.length - 3} more`
        : "";
    info(
      `                    ${head}${more} used fallback — rerun cairn scope rebuild`,
    );
  }
  info(`  Brand             ${brandReport}`);
  info(`  Scope index       ${scopeReport.line}`);
  if (scopeReport.followUp !== null) {
    info(`                    ${scopeReport.followUp}`);
  }
  if (args.logFilePath !== null) {
    info(`  Log               ${shortenHomePath(args.logFilePath)}`);
  }

  // Project brain populated from existing codebase.
  const ingestionReport = describeIngestion(args.ingestion);
  const canonicalReport = describeCanonical(args.ingestion);
  const baselineReport = describeBaseline(args.baselineAudit);
  if (
    ingestionReport !== null ||
    canonicalReport !== null ||
    baselineReport !== null
  ) {
    info("");
    info("  Project brain populated from existing codebase:");
    if (ingestionReport !== null) {
      info(`    DEC drafts        ${ingestionReport}`);
    }
    if (canonicalReport !== null) {
      info(`    Canonical map     ${canonicalReport}`);
    }
    if (baselineReport !== null) {
      info(`    Baseline debt     ${baselineReport}`);
    }
  }

  info("");
  info("  Open Claude Code in this directory. Cairn is live immediately.");
  info("");
  info("  Next: cairn attention        see pending items");
  info("        cairn doctor           verify everything is working");
  info("        cairn configure brand  fill in brand guidelines");

  if (args.warnings.length > 0) {
    info("");
    info(`  ${args.warnings.length} warning${args.warnings.length === 1 ? "" : "s"}:`);
    for (const w of args.warnings) info(`    ! ${w}`);
  }
}

function shortenHomePath(abs: string): string {
  const home = homedir();
  if (abs.startsWith(home)) return `~${abs.slice(home.length)}`;
  return abs;
}

function countGroundFiles(repoRoot: string): number {
  const groundDir = join(repoRoot, ".cairn", "ground");
  if (!existsSync(groundDir)) return 0;
  let count = 0;
  const stack: string[] = [groundDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "_inbox") continue;
        stack.push(abs);
      } else if (e.isFile()) {
        count++;
      }
    }
  }
  return count;
}

function countSensorEntries(repoRoot: string): number {
  const path = join(repoRoot, ".cairn", "config", "sensors.yaml");
  if (!existsSync(path)) return 0;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return 0;
    const sensorsRaw = (parsed as Record<string, unknown>)["sensors"];
    if (!Array.isArray(sensorsRaw)) return 0;
    return sensorsRaw.length;
  } catch {
    return 0;
  }
}

interface ScopeReport {
  line: string;
  followUp: string | null;
}

function describeScopeIndex(
  repoRoot: string,
  submodules: SubmoduleSummary | null,
  scanTruncated: boolean,
): ScopeReport {
  const path = join(repoRoot, ".cairn", "ground", "scope-index.yaml");
  const submoduleNoteJustInitialized =
    submodules !== null &&
    submodules.initialized &&
    submodules.success;
  const truncationFollowUp =
    "Run cairn scope rebuild for full classification";

  if (!existsSync(path)) {
    return {
      line: "missing — run cairn scope rebuild",
      followUp: null,
    };
  }
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {
        line: "empty — run cairn scope rebuild",
        followUp: null,
      };
    }
    const filesRaw = (parsed as Record<string, unknown>)["files"];
    if (typeof filesRaw !== "object" || filesRaw === null) {
      return {
        line: "empty — run cairn scope rebuild",
        followUp: null,
      };
    }
    const count = Object.keys(filesRaw as Record<string, unknown>).length;
    if (count === 0) {
      if (scanTruncated) {
        return {
          line: "empty — analysis was truncated during init",
          followUp: truncationFollowUp,
        };
      }
      return {
        line: submoduleNoteJustInitialized
          ? "empty — submodules now initialized, run cairn scope rebuild"
          : "empty — run cairn scope rebuild",
        followUp: null,
      };
    }
    if (scanTruncated) {
      return {
        line: "partial — analysis was truncated during init",
        followUp: truncationFollowUp,
      };
    }
    if (submoduleNoteJustInitialized) {
      return {
        line: `partial — ${count} file${count === 1 ? "" : "s"} classified (submodules now initialized)`,
        followUp: truncationFollowUp,
      };
    }
    return {
      line: `ready (${count} file${count === 1 ? "" : "s"} classified)`,
      followUp: null,
    };
  } catch {
    return {
      line: "unreadable — run cairn scope rebuild",
      followUp: null,
    };
  }
}

function describeBrandStatus(repoRoot: string): string {
  const overview = join(repoRoot, ".cairn", "ground", "brand", "overview.md");
  const positioning = join(
    repoRoot,
    ".cairn",
    "ground",
    "product",
    "positioning.md",
  );
  const voice = join(repoRoot, ".cairn", "ground", "brand", "voice.md");
  const all = [overview, positioning, voice];
  let currentCount = 0;
  let total = 0;
  for (const p of all) {
    if (!existsSync(p)) continue;
    total++;
    if (readFrontmatterStatus(p) === "current") currentCount++;
  }
  if (total === 0) return "missing — re-run cairn init";
  if (currentCount === total) return "ready";
  if (currentCount === 0) return "draft — run cairn configure brand";
  return `partial (${currentCount}/${total} current) — run cairn configure brand`;
}

function readFrontmatterStatus(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    const m = text.match(/^---\n([\s\S]*?\n)---/);
    if (!m) return null;
    const fm = m[1] ?? "";
    const sm = fm.match(/^status:\s*(\S+)\s*$/m);
    return sm && sm[1] ? sm[1] : null;
  } catch {
    return null;
  }
}

function describeMcpRegistration(repoRoot: string): string {
  const path = join(repoRoot, ".mcp.json");
  if (!existsSync(path)) return ".mcp.json · missing entry";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const servers = parsed["mcpServers"];
    if (typeof servers !== "object" || servers === null) {
      return ".mcp.json · missing cairn entry";
    }
    if ((servers as Record<string, unknown>)["cairn"] !== undefined) {
      return ".mcp.json · ready";
    }
    return ".mcp.json · missing cairn entry";
  } catch {
    return ".mcp.json · unreadable";
  }
}

function printDiscovery(
  d: DetectionResult,
  decidedSlug: string,
  warnings: string[],
  summary: RepoSummary,
): void {
  process.stdout.write("\n");
  process.stdout.write(`  ${visualC.bold("Scanning")}${visualC.dim("…")}\n`);

  // git root (we always have repo_root after detection)
  discoveryRow({ status: "ok", label: "git root", value: visualC.dim(d.repo_root) });

  // project slug
  const slugVal =
    decidedSlug + (decidedSlug === d.project_slug ? "" : visualC.dim("  (override)"));
  discoveryRow({ status: "ok", label: "project slug", value: slugVal });

  // remote
  const remote = d.origin_url;
  discoveryRow({
    status: remote !== null ? "ok" : "warn",
    label: "remote",
    value:
      remote !== null
        ? visualC.dim(remoteShorthand(remote))
        : visualC.dim("local-only repo"),
  });

  // stack signatures
  const stackKinds = d.stack_signatures.map((s) => s.kind);
  discoveryRow({
    status: stackKinds.length > 0 ? "ok" : "warn",
    label: "stack",
    value:
      stackKinds.length > 0
        ? visualC.dim(stackKinds.join(", "))
        : visualC.dim("unknown"),
  });

  // codebase scan — surfaces walker truncation so a degraded mapper input
  // can be acted on (run `cairn scope rebuild` after init).
  if (summary.truncated_at_file_cap) {
    discoveryRow({
      status: "warn",
      label: "codebase scan",
      value: visualC.dim("incomplete — file cap reached"),
    });
    process.stdout.write(
      `       ${visualC.dim("some source trees may be missing from analysis")}\n`,
    );
    process.stdout.write(
      `       ${visualC.dim("run: cairn scope rebuild  after init for full classification")}\n`,
    );
  } else if (summary.truncated_at_depth_cap) {
    discoveryRow({
      status: "warn",
      label: "codebase scan",
      value: visualC.dim("incomplete — depth cap reached"),
    });
    process.stdout.write(
      `       ${visualC.dim("run: cairn scope rebuild  after init for full classification")}\n`,
    );
  } else {
    discoveryRow({
      status: "ok",
      label: "codebase scan",
      value: visualC.dim(
        `${summary.total_files} files, ${summary.total_dirs} dirs`,
      ),
    });
  }

  // claude code
  const e = d.environment;
  discoveryRow({
    status: e.claude_auth ? "ok" : "err",
    label: "Claude Code",
    value: e.claude_auth
      ? visualC.dim("authenticated")
      : visualC.dim("missing or unauthenticated"),
  });
  if (!e.claude_auth) warnings.push("claude CLI not available");
}

interface PhaseSixArgs {
  repoRoot: string;
  decidedSlug: string;
  detection: DetectionResult;
  mapperOutput: MapperOutput | null;
  skip: boolean;
  warnings: string[];
}

interface PhaseSixResult {
  ingestion: IngestionResult | null;
  baselineAudit: BaselineAuditResult | null;
}

async function runPhaseSix(args: PhaseSixArgs): Promise<PhaseSixResult> {
  if (args.skip) {
    return { ingestion: null, baselineAudit: null };
  }

  process.stdout.write("\n");
  process.stdout.write(
    `  ${visualC.bold("Phase 6")} — ingesting existing project knowledge…\n`,
  );

  // ── 6.1 — docs ingestion (Haiku per doc; cap 20 largest) ───────────
  let ingestion: IngestionResult | null = null;
  try {
    ingestion = await runDocsIngestion({
      repoRoot: args.repoRoot,
      onGroupProgress: (row) => {
        const status = row.ok ? "✓" : "✗";
        const label = row.group.padEnd(20);
        const summary =
          row.drafts > 0
            ? `${row.drafts} DEC draft${row.drafts === 1 ? "" : "s"} proposed`
            : `${row.total} doc${row.total === 1 ? "" : "s"} scanned`;
        process.stdout.write(`    ${label} ${status}  ${summary}\n`);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    args.warnings.push(`docs ingestion failed: ${msg}`);
    process.stdout.write(
      `    ${visualC.yellow("⚠")} docs ingestion failed — ${msg}\n`,
    );
    ingestion = null;
  }

  // ── 6.4 — baseline sensor sweep (full repo, not a diff) ────────────
  let baselineAudit: BaselineAuditResult | null = null;
  try {
    const stackKinds = args.detection.stack_signatures.map((s) => s.kind);
    const projectGlobs = {
      route_handler_globs: args.mapperOutput?.route_handler_globs ?? [],
      dto_globs: args.mapperOutput?.dto_globs ?? [],
      generator_source_globs: args.mapperOutput?.generator_source_globs ?? [],
      high_stakes_globs: args.mapperOutput?.high_stakes_globs ?? [],
    };
    const printedSensors: string[] = [];
    let suppressedCount = 0;
    baselineAudit = await runBaselineAudit({
      repoRoot: args.repoRoot,
      languages: defaultBaselineLanguages(stackKinds),
      projectGlobs,
      onSensorProgress: (row) => {
        if (printedSensors.length < 3) {
          const id = row.sensor_id.padEnd(22);
          const status = row.skipped
            ? visualC.dim("skipped")
            : row.finding_count > 0
              ? `${row.finding_count} existing violation${row.finding_count === 1 ? "" : "s"} found`
              : "clean";
          process.stdout.write(
            `    ${id} ${row.skipped ? "○" : row.finding_count > 0 ? "⚠" : "✓"}  ${status}\n`,
          );
          printedSensors.push(row.sensor_id);
        } else {
          suppressedCount += 1;
        }
      },
    });
    if (suppressedCount > 0) {
      process.stdout.write(`    ${visualC.dim(`+ ${suppressedCount} more…`)}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    args.warnings.push(`baseline audit failed: ${msg}`);
    process.stdout.write(
      `    ${visualC.yellow("⚠")} baseline audit failed — ${msg}\n`,
    );
    baselineAudit = null;
  }

  return { ingestion, baselineAudit };
}

function describeIngestion(ingestion: IngestionResult | null): string | null {
  if (ingestion === null) return null;
  const draftCount = ingestion.decDraftsWritten.length;
  if (draftCount === 0 && !ingestion.voiceUpdated) {
    return `0 proposed  (no actionable docs found)`;
  }
  const parts: string[] = [];
  parts.push(
    `${draftCount} proposed${draftCount > 0 ? "  (run cairn attention to review)" : ""}`,
  );
  if (ingestion.voiceUpdated) {
    parts.push("brand/voice.md filled from existing doc");
  }
  return parts.join("; ");
}

function describeCanonical(ingestion: IngestionResult | null): string | null {
  if (ingestion === null) return null;
  const n = ingestion.canonicalTopicsAdded.length;
  if (n === 0) return null;
  return `${n} topic${n === 1 ? "" : "s"} seeded`;
}

function describeBaseline(audit: BaselineAuditResult | null): string | null {
  if (audit === null) return null;
  if (audit.totalFindings === 0) {
    if (audit.skippedSensorIds.length > 0 && audit.cleanSensorIds.length === 0) {
      return null;
    }
    return `0 findings  (run on ${audit.filesScanned} files)`;
  }
  return `${audit.totalFindings} existing sensor finding${audit.totalFindings === 1 ? "" : "s"}  (run cairn attention)`;
}

function remoteShorthand(url: string): string {
  // https://github.com/foo/bar.git → github.com/foo/bar
  // git@github.com:foo/bar.git    → github.com/foo/bar
  let s = url.replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^git@([^:]+):/, "$1/");
  return s;
}
