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
import { ensureMirror, normalizeProjectName } from "../mirror/index.js";
import { homedir } from "node:os";
import { logger, setLogFile } from "../logger.js";
import {
  applyBrandAnswers,
  runBrandSetup,
  type BrandAnswers,
} from "./brand-setup.js";
import {
  tryStartDaemon,
  type DaemonAutostartResult,
} from "./daemon-autostart.js";
import { detectAll } from "./detect.js";
import {
  runGitSubmoduleUpdate,
  scanSubmodules,
  type SubmoduleInfo,
} from "./submodules.js";
import {
  runMapper,
  validateMapperOutput,
  type MapperOutput,
  type MapperResult,
} from "./mapper.js";
import {
  done,
  editYaml,
  freeTextWithDefault,
  header,
  info,
  secretInput,
  squareIntoSquareHole,
  yesNo,
  type PromptMode,
} from "./prompts.js";
import { upsertHarnessEnv } from "./secrets.js";
import { seedHarnessLayout } from "./seed.js";
import {
  downloadWhisperModel,
  offerInstallOllama,
  pullOllamaModel,
  runHarnessSetupScript,
} from "./setup-runners.js";
import type { DetectionResult } from "./types.js";
import { buildRepoSummary } from "./walker.js";
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
  /** Skip mirror clone — useful for smoke and offline testing. */
  skipMirror?: boolean;
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
   * Skip the daemon autostart attempt (Phase 5c). Smokes default to skipping
   * since the daemon isn't installed in the test environment.
   */
  skipDaemonAutostart?: boolean;
  /**
   * Skip the submodule detection + init prompt (Phase 1). Smokes set this so
   * temp dir fixtures don't trip on git submodule lookups.
   */
  skipSubmoduleCheck?: boolean;
  /**
   * When mode === "auto", how to answer the submodule init prompt.
   *   "init"  — run `git submodule update --init --recursive`
   *   "skip"  — leave uninitialized, accept partial mapper visibility
   * Default `"init"` matches the interactive default.
   */
  autoSubmodule?: "init" | "skip";
}

export interface InitResult {
  detection: DetectionResult;
  decided_slug: string;
  proceed: boolean;
  seeded_files: string[];
  collisions: string[];
  config_path: string;
  mirror_path: string | null;
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
  /** Daemon autostart outcome (Phase 5c). null when skipped. */
  daemon_autostart: DaemonAutostartResult | null;
  /** Absolute path to the log file pino output was redirected to. */
  log_file_path: string | null;
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
  const mode: PromptMode = args.mode ?? "interactive";
  const warnings: string[] = [];

  // ── Phase 0: redirect pino logs to a file so JSON lines never reach stdout.
  const logFilePath = redirectInitLogs();

  header(`Harness init — ${repoRoot}`);

  if (!existsSync(join(repoRoot, ".git"))) {
    warnings.push(
      "no .git directory — mirror init will be skipped; the harness expects a git-tracked working tree",
    );
  }

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
  printSummary(detection, decidedSlug);
  printAdvisoryWarnings(detection, warnings);

  // ── Dialog 1: proceed? ──────────────────────────────────────────────
  const proceedChoice = await squareIntoSquareHole({
    mode,
    prompt: "Continue with these defaults?",
    choices: [
      { id: "a", label: "yes — seed .harness/, set up mirror, configure", isDefault: true },
      { id: "b", label: "cancel" },
    ],
    auto: args.autoProceed ?? "a",
  });
  if (proceedChoice === "b") {
    info("\ncancelled — no files written.");
    return {
      detection,
      decided_slug: decidedSlug,
      proceed: false,
      seeded_files: [],
      collisions: [],
      config_path: "",
      mirror_path: null,
      e2e_setup: null,
      mapper_output: null,
      mapper_applied_to_workflow: false,
      mapper_applied_to_config: false,
      brand_setup: null,
      daemon_autostart: null,
      log_file_path: logFilePath,
      submodules: submoduleSummary,
      warnings,
    };
  }

  // ── Guided setup: fix each missing prerequisite ────────────────────
  let envState = detection.environment;
  if (mode === "interactive" && args.skipGuidedSetup !== true) {
    envState = await runGuidedSetup({ envState, warnings, mode });
  }

  // ── Init mapper (Tier 2 / Sonnet) — proposes pilot_module + project_globs.
  // Without this, project_globs.{route_handler,dto,generator_source,high_stakes}
  // sit empty and Layer-D sensors never fire on real diffs (rework brief §3.1).
  const mapperOutput = await maybeRunMapper({
    repoRoot,
    detection,
    mode,
    skipMapper: args.skipMapper === true,
    ...(args.mockMapperOutput !== undefined
      ? { mockMapperOutput: args.mockMapperOutput }
      : {}),
    envClaudeAuth: envState.claude_auth,
    warnings,
  });

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

  // ── Step 4: mirror ─────────────────────────────────────────────────
  let mirrorPath: string | null = null;
  if (args.skipMirror === true) {
    info("\nmirror init skipped (--skip-mirror)");
  } else if (detection.origin_url === null) {
    warnings.push("no git origin — mirror init skipped");
    info("\nmirror init skipped (no git origin)");
  } else {
    header(`Mirror checkout → ~/.local/harness/repos/${decidedSlug}/`);
    try {
      const record = await ensureMirror({
        projectName: decidedSlug,
        originUrl: detection.origin_url,
        userTreePath: repoRoot,
      });
      mirrorPath = record.mirrorPath;
      done(`+ ${mirrorPath}`);
    } catch (err) {
      warnings.push(`mirror init failed: ${String(err)}`);
      info(`mirror init failed: ${String(err)}`);
    }
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

  // ── Step 5c: daemon autostart ──────────────────────────────────────
  let daemonAutostart: DaemonAutostartResult | null = null;
  if (args.skipDaemonAutostart !== true) {
    daemonAutostart = await tryStartDaemon(repoRoot);
  }

  // ── Step 6: completion summary (structured) ────────────────────────
  printCompletionSummary({
    projectName: decidedSlug,
    repoRoot,
    seededFiles: seed.written_files,
    brandSetup,
    daemonAutostart,
    submodules: submoduleSummary,
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
      daemon_started: daemonAutostart?.started ?? null,
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
    mirror_path: mirrorPath,
    e2e_setup: e2eChoice,
    mapper_output: mapperOutput,
    mapper_applied_to_workflow: mapperAppliedToWorkflow,
    mapper_applied_to_config: mapperAppliedToConfig,
    brand_setup: brandSetup,
    daemon_autostart: daemonAutostart,
    log_file_path: logFilePath,
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

/**
 * For each missing prerequisite, prompt the operator to fix it. Returns
 * the (possibly mutated) environment state.
 *
 * Order matters: claude → whisper → ollama → discord. Claude is the
 * hardest blocker (no Tier-1 calls without it); discord is the most
 * likely missing piece (operator hasn't pasted the bot token yet).
 */
async function runGuidedSetup(args: {
  envState: DetectionResult["environment"];
  warnings: string[];
  mode: PromptMode;
}): Promise<DetectionResult["environment"]> {
  const env = { ...args.envState };
  header("Guided setup — fixing missing prerequisites");

  // ── claude CLI: can't auto. ─────────────────────────────────────────
  if (!env.claude_auth) {
    info("");
    info("✗ claude CLI is missing or unauthenticated.");
    info("  Install:  https://docs.claude.com/claude-code");
    info("  Then run: claude   (one-time interactive auth)");
    const ack = await yesNo({
      mode: args.mode,
      prompt: "Continue without claude? (Tier-1+ LLM calls will fail.)",
      defaultYes: false,
    });
    if (!ack) {
      throw new Error(
        "init aborted — operator declined to continue without claude",
      );
    }
    args.warnings.push("claude CLI not available — Tier-1+ LLM calls will fail");
  } else {
    done("✓ claude CLI authenticated");
  }

  // ── whisper model. ──────────────────────────────────────────────────
  if (!env.whisper_model) {
    info("");
    info("✗ whisper model not found at ~/.local/harness/models/.");
    const action = await yesNo({
      mode: args.mode,
      prompt: "Download whisper model now (~800MB, ~2 min on fast wifi)?",
      defaultYes: true,
    });
    if (action) {
      const r = await downloadWhisperModel();
      if (r.ok) {
        env.whisper_model = true;
        done("✓ whisper model downloaded");
      } else {
        args.warnings.push(`whisper download failed (${r.exit_code}) — re-run manually`);
      }
    } else {
      args.warnings.push("whisper model not present — voice ingress disabled");
    }
  } else {
    done("✓ whisper model present");
  }

  // ── ollama service. ─────────────────────────────────────────────────
  if (!env.ollama_running) {
    info("");
    info("✗ ollama is not reachable on $OLLAMA_HOST (default http://localhost:11434).");
    const action = await squareIntoSquareHole<"install" | "skip">({
      mode: args.mode,
      prompt: "Set up Ollama (Tier-0 classifier)?",
      choices: [
        { id: "install", label: "install via brew + pull llama3.2:3b", isDefault: true },
        { id: "skip", label: "skip — Tier-0 falls back to regex" },
      ],
      auto: "skip",
    });
    if (action === "install") {
      const installR = await offerInstallOllama();
      if (installR.ok) done("✓ ollama installed");
      else args.warnings.push(`brew install ollama failed (${installR.exit_code})`);
      info("  starting ollama service in background — run `brew services start ollama`");
      info("  then: ollama pull llama3.2:3b");
      const pullR = await pullOllamaModel("llama3.2:3b");
      if (pullR.ok) {
        env.ollama_running = true;
        done("✓ llama3.2:3b pulled");
      } else {
        args.warnings.push(
          `ollama pull failed (${pullR.exit_code}) — start service then re-run`,
        );
      }
    } else {
      args.warnings.push("ollama skipped — Tier-0 uses regex fallback");
    }
  } else {
    done("✓ ollama reachable");
  }

  // ── discord token + guild. ──────────────────────────────────────────
  const discordMissing = !env.discord_token || !env.discord_guild;
  if (discordMissing) {
    info("");
    info("✗ Discord adapter not configured (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID missing).");
    const action = await squareIntoSquareHole<"enter" | "skip">({
      mode: args.mode,
      prompt: "Enter Discord bot credentials now?",
      choices: [
        {
          id: "enter",
          label: "enter token + guild now",
          description: "writes to ~/.local/harness/.env (mode 0600)",
          isDefault: true,
        },
        {
          id: "skip",
          label: "skip — use stub adapter for now",
          description: "you can `harness init` again later to add credentials",
        },
      ],
      auto: "skip",
    });
    if (action === "enter") {
      const updates: Record<string, string> = {};
      if (!env.discord_token) {
        const token = await secretInput({
          mode: args.mode,
          prompt: "DISCORD_BOT_TOKEN (Bot tab → Reset Token, paste hidden):",
        });
        if (token.length > 0) {
          updates["DISCORD_BOT_TOKEN"] = token;
          env.discord_token = true;
        }
      }
      if (!env.discord_guild) {
        const guild = await freeTextWithDefault({
          mode: args.mode,
          prompt: "DISCORD_GUILD_ID (right-click server → Copy Server ID):",
          defaultValue: "",
        });
        if (guild.trim().length > 0) {
          updates["DISCORD_GUILD_ID"] = guild.trim();
          env.discord_guild = true;
        }
      }
      if (Object.keys(updates).length > 0) {
        const path = upsertHarnessEnv(updates);
        done(`✓ wrote ${Object.keys(updates).join(" + ")} → ${path}`);
      } else {
        args.warnings.push("discord credentials skipped — adapter will fall back to stub");
      }
    } else {
      args.warnings.push("discord credentials skipped — adapter falls back to stub");
    }
  } else {
    done("✓ Discord credentials present");
  }

  return env;
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
  mode: PromptMode;
  skipMapper: boolean;
  mockMapperOutput?: MapperOutput;
  envClaudeAuth: boolean;
  warnings: string[];
}

async function maybeRunMapper(args: MaybeRunMapperArgs): Promise<MapperOutput | null> {
  if (args.mockMapperOutput !== undefined) {
    info("\n── Init mapper — using injected mockMapperOutput (smoke / scripted adoption)");
    return args.mockMapperOutput;
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

  header("Init mapper (Tier 2 / Sonnet) — proposing pilot_module + project_globs");
  info("  Walking repo (gitignore-aware, depth ≤ 5, file cap 3000)...");
  const summary = buildRepoSummary({ repoRoot: args.repoRoot });
  info(
    `  ${summary.total_files} files, ${summary.total_dirs} dirs, ${summary.package_manifests.length} manifests, ${summary.framework_signals.length} framework signals`,
  );
  if (summary.truncated_at_file_cap) info("  (truncated at file cap — pilot scope will be conservative)");
  if (summary.truncated_at_depth_cap) info("  (truncated at depth cap)");

  const dispatch = await squareIntoSquareHole<"go" | "skip">({
    mode: args.mode,
    prompt: "Dispatch mapper now (~$1-3 one-time, fills route_handler_globs / dto_globs / etc.)?",
    choices: [
      { id: "go", label: "yes — dispatch Sonnet", isDefault: true },
      { id: "skip", label: "skip — keep globs empty (you can re-run init later)" },
    ],
    auto: "skip",
  });
  if (dispatch === "skip") {
    args.warnings.push("mapper dispatch declined by operator — project_globs left empty");
    return null;
  }

  let mapperResult: MapperResult;
  try {
    info("  Dispatching... (typically 30-90s)");
    mapperResult = await runMapper({ detection: args.detection, summary });
  } catch (err) {
    args.warnings.push(`mapper dispatch failed: ${String(err)}`);
    info(`  ✗ mapper failed: ${String(err)}`);
    return null;
  }
  printMapperProposal(mapperResult);

  const choice = await squareIntoSquareHole<"apply" | "edit" | "skip">({
    mode: args.mode,
    prompt: "Apply mapper proposal?",
    choices: [
      { id: "apply", label: "apply as-is", isDefault: true },
      {
        id: "edit",
        label: "edit YAML before applying",
        description: `opens ${process.env["EDITOR"] ?? "vi"} on the proposal`,
      },
      {
        id: "skip",
        label: "skip — keep globs empty (re-run init later to retry)",
      },
    ],
    auto: "apply",
  });
  if (choice === "skip") {
    args.warnings.push(
      "mapper proposal declined at confirm — project_globs left empty",
    );
    return null;
  }
  if (choice === "edit") {
    const initialYaml = stringifyYaml(mapperResult.output);
    const edited = await editYaml({
      mode: args.mode,
      prompt: "Edit YAML proposal (save + exit to apply, leave empty to abort)",
      initial: initialYaml,
    });
    if (edited.trim().length === 0) {
      args.warnings.push(
        "mapper proposal aborted at edit (empty input) — project_globs left empty",
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(edited);
    } catch (err) {
      args.warnings.push(`mapper proposal edit returned invalid YAML: ${String(err)}`);
      return null;
    }
    try {
      return validateMapperOutput(parsed);
    } catch (err) {
      args.warnings.push(`edited mapper proposal failed shape check: ${String(err)}`);
      return null;
    }
  }
  return mapperResult.output;
}

function printMapperProposal(r: MapperResult): void {
  const o = r.output;
  info("");
  info(
    `Mapper proposal (${(r.duration_ms / 1000).toFixed(1)}s, in=${r.usage?.input_tokens ?? "?"} out=${r.usage?.output_tokens ?? "?"} tokens):`,
  );
  info(`  domain:           ${truncateOneLine(o.domain_summary, 90)}`);
  info(`  pilot_module:     ${o.pilot_module}`);
  info(`  key_modules (${o.key_modules.length}):`);
  for (const km of o.key_modules) {
    info(`    - ${km.name} (${km.path}) — ${truncateOneLine(km.purpose, 70)}`);
  }
  printGlobs(`route_handler_globs (${o.route_handler_globs.length})`, o.route_handler_globs);
  printGlobs(`dto_globs (${o.dto_globs.length})`, o.dto_globs);
  printGlobs(
    `generator_source_globs (${o.generator_source_globs.length})`,
    o.generator_source_globs,
  );
  printGlobs(`high_stakes_globs (${o.high_stakes_globs.length})`, o.high_stakes_globs);
  printGlobs(`off_limits_globs (${o.off_limits_globs.length})`, o.off_limits_globs);
  info(`  proposed_sensors (${o.proposed_sensors.length}):`);
  for (const ps of o.proposed_sensors) {
    info(
      `    - ${ps.id} — ${truncateOneLine(ps.description, 80)}  [${ps.applies_to_globs.join(", ")}]`,
    );
  }
  if (o.notes.trim().length > 0) info(`  notes: ${truncateOneLine(o.notes, 200)}`);
}

function printGlobs(label: string, globs: string[]): void {
  info(`  ${label}:`);
  if (globs.length === 0) {
    info(`    (none)`);
    return;
  }
  for (const g of globs) info(`    - ${g}`);
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
  daemonAutostart: DaemonAutostartResult | null;
  submodules: SubmoduleSummary | null;
  logFilePath: string | null;
  warnings: string[];
}

function printCompletionSummary(args: CompletionSummaryArgs): void {
  const groundCount = countGroundFiles(args.repoRoot);
  const sensorCount = countSensorEntries(args.repoRoot);
  const scopeReport = describeScopeIndex(args.repoRoot);
  const brandReport = describeBrandStatus(args.repoRoot);
  const daemonReport = describeDaemon(args.daemonAutostart);
  const hookReport = describeHooks(args.repoRoot);
  const mcpReport = describeMcpRegistration(args.repoRoot);

  info("");
  info(`  ✓ Harness ready — ${args.projectName}`);
  info("");
  info(`  Ground state      .harness/ground/ (${groundCount} files)`);
  info(`  MCP server        ${mcpReport}`);
  info(`  Hooks             ${hookReport}`);
  info(`  Sensors           ${sensorCount} active`);
  info(`  Brand             ${brandReport}`);
  info(`  Scope index       ${scopeReport}`);
  info(`  Daemon            ${daemonReport}`);
  if (args.logFilePath !== null) {
    info(`  Log               ${shortenHomePath(args.logFilePath)}`);
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

function describeScopeIndex(repoRoot: string): string {
  const path = join(repoRoot, ".harness", "ground", "scope-index.yaml");
  if (!existsSync(path)) return "missing — run harness scope rebuild";
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return "empty — run harness scope rebuild";
    }
    const filesRaw = (parsed as Record<string, unknown>)["files"];
    if (typeof filesRaw !== "object" || filesRaw === null) {
      return "empty — run harness scope rebuild";
    }
    const count = Object.keys(filesRaw as Record<string, unknown>).length;
    if (count === 0) return "empty — run harness scope rebuild";
    return `ready (${count} file${count === 1 ? "" : "s"} classified)`;
  } catch {
    return "unreadable — run harness scope rebuild";
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

function describeDaemon(result: DaemonAutostartResult | null): string {
  if (result === null) return "not started — run harness daemon start";
  if (result.started) {
    return result.pid !== null
      ? `started (PID ${result.pid})`
      : "started";
  }
  if (result.reason !== null && result.reason.includes("on PATH")) {
    return "not started — install harness globally then run harness daemon start";
  }
  return "not started — run harness daemon start";
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

function printSummary(d: DetectionResult, decidedSlug: string): void {
  info("");
  info("DETECTED:");
  info(`  project_slug:    ${decidedSlug}${decidedSlug === d.project_slug ? "" : "  (override)"}`);
  info(`  origin_url:      ${d.origin_url ?? "(none — local-only repo)"}`);
  info(
    `  stack:           ${d.stack_signatures.map((s) => s.kind).join(", ") || "unknown"}`,
  );
  if (d.start_command !== null) {
    info(
      `  start_command:   ${[d.start_command.command, ...d.start_command.args].join(" ")}  (${d.start_command.reason})`,
    );
  } else {
    info(`  start_command:   (none detected — UAT-on-phone needs manual config)`);
  }
  info(`  hook_capability: ${d.hook_capability}`);
  if (d.proposed_sensors.length > 0) {
    info(`  proposed sensors:`);
    for (const s of d.proposed_sensors) {
      info(`    - ${s.id} (${s.command} ${s.args.join(" ")}) — ${s.reason}`);
    }
  } else {
    info(`  proposed sensors: (none — generic harness layer A/B/C/D still apply)`);
  }
}

function printAdvisoryWarnings(
  d: DetectionResult,
  warnings: string[],
): void {
  info("");
  info("ENVIRONMENT:");
  const e = d.environment;
  info(`  claude CLI:    ${e.claude_auth ? "ok" : "missing — install + authenticate Claude Code"}`);
  if (!e.claude_auth) warnings.push("claude CLI not available");
  info(
    `  whisper model: ${e.whisper_model ? "ok" : "missing — voice ingress disabled"}`,
  );
  if (!e.whisper_model)
    warnings.push(
      "whisper model not at ~/.local/harness/models/ggml-large-v3-turbo-q5_0.bin — voice ingress disabled",
    );
  info(
    `  ollama:        ${e.ollama_running ? "ok" : "not reachable — Tier-0 falls back to regex classifier"}`,
  );
  if (!e.ollama_running)
    warnings.push("ollama not reachable on $OLLAMA_HOST — Tier-0 falls back to regex");
  info(
    `  discord token: ${e.discord_token ? "ok" : "missing — discord adapter unusable"}`,
  );
  if (!e.discord_token) warnings.push("DISCORD_BOT_TOKEN not set in env");
  info(
    `  discord guild: ${e.discord_guild ? "ok" : "missing — discord adapter unusable"}`,
  );
  if (!e.discord_guild) warnings.push("DISCORD_GUILD_ID not set in env");
}
