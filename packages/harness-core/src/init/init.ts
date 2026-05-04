/**
 * `harness init` orchestrator — full guided setup.
 *
 * Stages:
 *   1. Detect → print summary
 *   2. Proceed dialog (cancel exits cleanly, no writes)
 *   3. Guided setup loop — for each missing prerequisite, prompt to fix:
 *        • discord bot token + guild → write to ~/.local/harness/.env
 *        • whisper model → curl download
 *        • ollama service → brew install + ollama pull
 *        • claude CLI → instruct (interactive auth, can't automate)
 *   4. Seed `.harness/` + .archive/ from templates with `<project_name>`
 *      substituted. Write `.harness/config.yaml`.
 *   5. Mirror init (skippable).
 *   6. E2E dialog — now actually executes setup:uat-* via subprocess.
 *
 * Pre-configured environment skips guided setup dialogs entirely; init
 * for an already-set-up operator runs proceed + e2e and that's it.
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
  detectMonorepoContext,
  findGitRoot,
  isHarnessSourceRepo,
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
import { seedHarnessLayout } from "./seed.js";
import {
  downloadWhisperModel,
  runHarnessSetupScript,
} from "./setup-runners.js";
import type { DetectionResult } from "./types.js";
import { buildRepoSummary, type RepoSummary } from "./walker.js";
import { updateWorkflowSlugBlock } from "./workflow-block.js";

const log = logger("init");

export interface RunInitArgs {
  /** Repo root the operator wants to adopt. Default = process.cwd(). */
  repoRoot?: string;
  /** Override the detected slug. Useful for `harness init . --slug foo`. */
  slugOverride?: string;
  /** auto = no prompts (smoke / scripted adoption). interactive = real wizard. */
  mode?: PromptMode;
  /** Force-overwrite existing `.harness/` files. Default false. */
  force?: boolean;
  /** Auto-pick the E2E setup answer when mode=auto. */
  autoE2e?: "now" | "defer" | "skip";
  /** Auto-pick proceed? when mode=auto. */
  autoProceed?: "a" | "b";
  /** Skip guided setup (claude/whisper/ollama/discord) — smoke convenience. */
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
   * can run init against the harness source repo for development.
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
}

export interface InitResult {
  detection: DetectionResult;
  decided_slug: string;
  proceed: boolean;
  seeded_files: string[];
  collisions: string[];
  config_path: string;
  e2e_setup: "now" | "defer" | "skip" | null;
  /** Mapper outcome — null when skipped/failed, full output when applied. */
  mapper_output: MapperOutput | null;
  /** Whether mapper output reached the workflow.md slug block. */
  mapper_applied_to_workflow: boolean;
  /** Whether mapper output reached the new .harness/config.yaml. */
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

const DEFAULT_OFF_LIMITS = [
  ".env",
  ".env.*",
  "node_modules/",
  "dist/",
  "build/",
  "target/",
  "__pycache__/",
  "vendor/",
  ".venv/",
  ".direnv/",
  ".cache/",
  "coverage/",
];

export async function runInit(args: RunInitArgs = {}): Promise<InitResult> {
  const repoRoot = args.repoRoot ?? process.cwd();
  const cwd = process.cwd();
  const mode: PromptMode = args.mode ?? "interactive";
  const warnings: string[] = [];

  // ── Phase -1: self-adoption hard stop ──────────────────────────────
  // If repoRoot or cwd looks like the Harness source repo itself, refuse —
  // running init here would overwrite harness internals.
  if (args.skipSelfAdoptionGuard !== true) {
    if (isHarnessSourceRepo(repoRoot) || isHarnessSourceRepo(cwd)) {
      info("");
      info("  ✗  This looks like the Harness source repository.");
      info("     Running init here would overwrite harness internals.");
      info("");
      info("  harness init is for projects that USE Harness, not for Harness itself.");
      info("  If you're developing Harness, you don't need to run init.");
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

  header(`Harness init — ${repoRoot}`);

  if (!existsSync(join(repoRoot, ".git"))) {
    warnings.push(
      "no .git directory — mirror init will be skipped; the harness expects a git-tracked working tree",
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
      e2e_setup: null,
      mapper_output: null,
      mapper_applied_to_workflow: false,
      mapper_applied_to_config: false,
      brand_setup: null,
      ingestion: null,
      baseline_audit: null,
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
  header("Seeding .harness/ + .archive/");
  const seed = seedHarnessLayout({
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
  const wfRelPath = ".harness/config/workflow.md";
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
  header("Writing .harness/config.yaml");
  const configPath = join(repoRoot, ".harness", "config.yaml");
  mkdirSync(join(repoRoot, ".harness"), { recursive: true });
  let mapperAppliedToConfig = false;
  if (existsSync(configPath) && args.force !== true) {
    warnings.push(`.harness/config.yaml already exists — kept existing (use --force to overwrite)`);
    done(`= .harness/config.yaml (kept)`);
    if (mapperOutput !== null) {
      warnings.push(
        `mapper output NOT applied to .harness/config.yaml — kept existing; project_globs may be stale`,
      );
    }
  } else {
    const config = buildProjectOverlay({
      detection,
      decidedSlug,
      ...(mapperOutput !== null ? { mapperOutput } : {}),
    });
    writeFileSync(configPath, stringifyYaml(config), "utf8");
    done(`+ .harness/config.yaml`);
    if (mapperOutput !== null) mapperAppliedToConfig = true;
  }

  // ── Step 3b: scope-index.yaml ──────────────────────────────────────
  header("Writing .harness/ground/scope-index.yaml");
  const scopeIndexFile = scopeIndexPath(repoRoot);
  if (existsSync(scopeIndexFile) && args.force !== true) {
    warnings.push(
      ".harness/ground/scope-index.yaml already exists — kept existing (use --force to overwrite)",
    );
    done(`= .harness/ground/scope-index.yaml (kept)`);
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
    done(`+ .harness/ground/scope-index.yaml`);
  }

  // ── Dialog 2: E2E setup ────────────────────────────────────────────
  const e2eChoice = await squareIntoSquareHole<"now" | "defer" | "skip">({
    mode,
    prompt: "E2E heavy probes (browsers / sql / docker compose) — set up now?",
    choices: [
      {
        id: "now",
        label: "now",
        description: "run setup:uat-browsers + setup:uat-sql --build-binding + setup:uat-docker",
      },
      {
        id: "defer",
        label: "defer (recommended for first adoption)",
        description: "orchestrator prompts again on the first UAT need",
        isDefault: true,
      },
      {
        id: "skip",
        label: "skip",
        description:
          "code-class UAT becomes review-only; high-stakes refused dispatch",
      },
    ],
    auto: args.autoE2e ?? "defer",
  });
  recordE2eDecision({ repoRoot, e2eChoice });
  if (e2eChoice === "now") {
    header("E2E setup — running setup:uat-browsers + setup:uat-sql + setup:uat-docker");
    const browsers = await runHarnessSetupScript("setup-uat-browsers");
    if (!browsers.ok) {
      warnings.push(`setup:uat-browsers exited ${browsers.exit_code} — re-run manually`);
    }
    const sql = await runHarnessSetupScript("setup-uat-sql", ["--build-binding"]);
    if (!sql.ok) {
      warnings.push(`setup:uat-sql exited ${sql.exit_code} — re-run manually`);
    }
    const docker = await runHarnessSetupScript("setup-uat-docker");
    if (!docker.ok) {
      warnings.push(`setup:uat-docker exited ${docker.exit_code} — re-run manually`);
    }
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
  // Harness debt. Both pieces are best-effort; failures degrade to empty
  // result, never block the init.
  const phase6 = await runPhaseSix({
    repoRoot,
    decidedSlug,
    detection,
    mapperOutput,
    skip: args.skipIngestion === true || mode === "auto",
    warnings,
  });

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
      e2e: e2eChoice,
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
    config_path: ".harness/config.yaml",
    e2e_setup: e2eChoice,
    mapper_output: mapperOutput,
    mapper_applied_to_workflow: mapperAppliedToWorkflow,
    mapper_applied_to_config: mapperAppliedToConfig,
    brand_setup: brandSetup,
    ingestion: phase6.ingestion,
    baseline_audit: phase6.baselineAudit,
    log_file_path: logFilePath,
    monorepo_context: monorepoContext,
    submodules: submoduleSummary,
    warnings,
  };

  function recordE2eDecision(a: {
    repoRoot: string;
    e2eChoice: "now" | "defer" | "skip";
  }): void {
    const p = join(a.repoRoot, ".harness", "config.yaml");
    if (!existsSync(p)) return;
    const text = readFileSync(p, "utf8");
    if (/^e2e_setup:/m.test(text)) {
      const updated = text.replace(/^e2e_setup:.*$/m, `e2e_setup: ${a.e2eChoice}`);
      writeFileSync(p, updated, "utf8");
    } else {
      writeFileSync(
        p,
        text + (text.endsWith("\n") ? "" : "\n") + `e2e_setup: ${a.e2eChoice}\n`,
        "utf8",
      );
    }
  }
}

function buildProjectOverlay(args: {
  detection: DetectionResult;
  decidedSlug: string;
  mapperOutput?: MapperOutput;
}): Record<string, unknown> {
  const detected_sensor_commands = args.detection.proposed_sensors.map((s) => ({
    id: s.id,
    command: s.command,
    args: s.args,
    applies_to: s.applies_to,
    reason: s.reason,
  }));

  const m = args.mapperOutput;
  const offLimits = [...DEFAULT_OFF_LIMITS];
  if (m !== undefined) {
    for (const x of m.off_limits_globs) {
      if (!offLimits.includes(x)) offLimits.push(x);
    }
  }

  const overlay: Record<string, unknown> = {
    version: 1,
    slug: args.decidedSlug,
    origin_url: args.detection.origin_url,
    stack_signatures: args.detection.stack_signatures.map((s) => s.kind),
    hook_capability: args.detection.hook_capability,
    start_command: args.detection.start_command,
    detected_sensor_commands,
    off_limits: offLimits,
    high_stakes_globs: m?.high_stakes_globs ?? [],
    project_globs: {
      route_handler_globs: m?.route_handler_globs ?? [],
      dto_globs: m?.dto_globs ?? [],
      generator_source_globs: m?.generator_source_globs ?? [],
      high_stakes_globs: m?.high_stakes_globs ?? [],
    },
  };
  if (m !== undefined) {
    overlay["pilot_module"] = m.pilot_module;
    overlay["domain_summary"] = m.domain_summary;
    overlay["key_modules"] = m.key_modules;
    overlay["mapper_proposed_sensors"] = m.proposed_sensors;
    if (m.notes.trim().length > 0) overlay["mapper_notes"] = m.notes;
  }
  return overlay;
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
    if (mapperResult.path === "legacy") {
      spinner.succeed(`Analysis complete (${seconds} · legacy fallback)`);
    } else if (failedModules > 0) {
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
      `mapper fallback used for: ${fallbackSlugs.join(", ")} — rerun \`harness scope rebuild\` for full classification`,
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
      ? `  ${visualC.dim(`(only fully-visible module — run harness scope rebuild after submodules initialize)`)}`
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
    "harness",
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
    info(`    cd ${ctx.workspaceRoot} && harness init`);
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
        .join(", ")}. Re-run \`git submodule update --init --recursive\` then \`harness scope rebuild\`.`,
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
      `submodule init failed (${result.errorSummary ?? "unknown"}) — mapper has partial visibility. Re-run \`git submodule update --init --recursive\` manually then \`harness scope rebuild\`.`,
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
  const hookReport = describeHooks(args.repoRoot);
  const mcpReport = describeMcpRegistration(args.repoRoot);

  info("");
  info(`  ✓ Harness ready — ${args.projectName}`);
  info("");
  info(`  Ground state      .harness/ground/ (${groundCount} files)`);
  info(`  MCP server        ${mcpReport}`);
  info(`  Hooks             ${hookReport}`);
  info(`  Sensors           ${sensorCount} active`);
  if (args.mapperFallbackSlugs.length > 0) {
    const head = args.mapperFallbackSlugs.slice(0, 3).join(", ");
    const more =
      args.mapperFallbackSlugs.length > 3
        ? ` +${args.mapperFallbackSlugs.length - 3} more`
        : "";
    info(
      `                    ${head}${more} used fallback — rerun harness scope rebuild`,
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
  info("  Open Claude Code in this directory. Harness is live immediately.");
  info("");
  info("  Next: harness attention        see pending items");
  info("        harness doctor           verify everything is working");
  info("        harness configure brand  fill in brand guidelines");

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
  const groundDir = join(repoRoot, ".harness", "ground");
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
  const path = join(repoRoot, ".harness", "config", "sensors.yaml");
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
  const path = join(repoRoot, ".harness", "ground", "scope-index.yaml");
  const submoduleNoteJustInitialized =
    submodules !== null &&
    submodules.initialized &&
    submodules.success;
  const truncationFollowUp =
    "Run harness scope rebuild for full classification";

  if (!existsSync(path)) {
    return {
      line: "missing — run harness scope rebuild",
      followUp: null,
    };
  }
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {
        line: "empty — run harness scope rebuild",
        followUp: null,
      };
    }
    const filesRaw = (parsed as Record<string, unknown>)["files"];
    if (typeof filesRaw !== "object" || filesRaw === null) {
      return {
        line: "empty — run harness scope rebuild",
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
          ? "empty — submodules now initialized, run harness scope rebuild"
          : "empty — run harness scope rebuild",
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
      line: "unreadable — run harness scope rebuild",
      followUp: null,
    };
  }
}

function describeBrandStatus(repoRoot: string): string {
  const overview = join(repoRoot, ".harness", "ground", "brand", "overview.md");
  const positioning = join(
    repoRoot,
    ".harness",
    "ground",
    "product",
    "positioning.md",
  );
  const voice = join(repoRoot, ".harness", "ground", "brand", "voice.md");
  const all = [overview, positioning, voice];
  let currentCount = 0;
  let total = 0;
  for (const p of all) {
    if (!existsSync(p)) continue;
    total++;
    if (readFrontmatterStatus(p) === "current") currentCount++;
  }
  if (total === 0) return "missing — re-run harness init";
  if (currentCount === total) return "ready";
  if (currentCount === 0) return "draft — run harness configure brand";
  return `partial (${currentCount}/${total} current) — run harness configure brand`;
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

function describeHooks(repoRoot: string): string {
  const path = join(repoRoot, ".claude", "settings.json");
  if (!existsSync(path)) return "missing .claude/settings.json";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const hooks = parsed["hooks"];
    if (typeof hooks !== "object" || hooks === null) return "missing entries";
    const sessionStart = (hooks as Record<string, unknown>)["SessionStart"];
    const postToolUse = (hooks as Record<string, unknown>)["PostToolUse"];
    const labels: string[] = [];
    if (Array.isArray(sessionStart) && sessionStart.length > 0) {
      labels.push("SessionStart");
    }
    if (Array.isArray(postToolUse) && postToolUse.length > 0) {
      labels.push("PostToolUse (read-enricher, write-guardian)");
    }
    return labels.length === 0 ? "no entries" : labels.join(" · ");
  } catch {
    return "unreadable";
  }
}

function describeMcpRegistration(repoRoot: string): string {
  const path = join(repoRoot, ".mcp.json");
  if (!existsSync(path)) return ".mcp.json · missing entry";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const servers = parsed["mcpServers"];
    if (typeof servers !== "object" || servers === null) {
      return ".mcp.json · missing harness entry";
    }
    if ((servers as Record<string, unknown>)["harness"] !== undefined) {
      return ".mcp.json · ready";
    }
    return ".mcp.json · missing harness entry";
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
  // can be acted on (run `harness scope rebuild` after init).
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
      `       ${visualC.dim("run: harness scope rebuild  after init for full classification")}\n`,
    );
  } else if (summary.truncated_at_depth_cap) {
    discoveryRow({
      status: "warn",
      label: "codebase scan",
      value: visualC.dim("incomplete — depth cap reached"),
    });
    process.stdout.write(
      `       ${visualC.dim("run: harness scope rebuild  after init for full classification")}\n`,
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

  // whisper
  discoveryRow({
    status: e.whisper_model ? "ok" : "warn",
    label: "whisper",
    value: e.whisper_model
      ? visualC.dim("model present")
      : visualC.dim("model not found"),
  });
  if (!e.whisper_model)
    warnings.push(
      "whisper model not at ~/.local/harness/models/ggml-large-v3-turbo-q5_0.bin — voice ingress disabled",
    );
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
    `${draftCount} proposed${draftCount > 0 ? "  (run harness attention to review)" : ""}`,
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
  return `${audit.totalFindings} existing sensor finding${audit.totalFindings === 1 ? "" : "s"}  (run harness attention)`;
}

function remoteShorthand(url: string): string {
  // https://github.com/foo/bar.git → github.com/foo/bar
  // git@github.com:foo/bar.git    → github.com/foo/bar
  let s = url.replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^git@([^:]+):/, "$1/");
  return s;
}
