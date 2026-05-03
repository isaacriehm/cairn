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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ensureMirror, normalizeProjectName } from "../mirror/index.js";
import { logger } from "../logger.js";
import { detectAll, detectEnvironment } from "./detect.js";
import {
  done,
  freeTextWithDefault,
  header,
  info,
  secretInput,
  squareIntoSquareHole,
  yesNo,
  type PromptMode,
} from "./prompts.js";
import { harnessEnvPath, upsertHarnessEnv } from "./secrets.js";
import { seedHarnessLayout } from "./seed.js";
import {
  downloadWhisperModel,
  offerInstallOllama,
  pullOllamaModel,
  runHarnessSetupScript,
} from "./setup-runners.js";
import type { DetectionResult } from "./types.js";

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

  header(`Harness init — ${repoRoot}`);

  if (!existsSync(join(repoRoot, ".git"))) {
    warnings.push(
      "no .git directory — mirror init will be skipped; the harness expects a git-tracked working tree",
    );
  }

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
      warnings,
    };
  }

  // ── Guided setup: fix each missing prerequisite ────────────────────
  let envState = detection.environment;
  if (mode === "interactive" && args.skipGuidedSetup !== true) {
    envState = await runGuidedSetup({ envState, warnings, mode });
  }

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

  // ── Step 3: write project-overlay config.yaml ──────────────────────
  header("Writing .harness/config.yaml");
  const configPath = join(repoRoot, ".harness", "config.yaml");
  mkdirSync(join(repoRoot, ".harness"), { recursive: true });
  if (existsSync(configPath) && args.force !== true) {
    warnings.push(`.harness/config.yaml already exists — kept existing (use --force to overwrite)`);
    done(`= .harness/config.yaml (kept)`);
  } else {
    const config = buildProjectOverlay({ detection, decidedSlug, repoRoot });
    writeFileSync(configPath, stringifyYaml(config), "utf8");
    done(`+ .harness/config.yaml`);
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

  // ── Step 5: next-steps ─────────────────────────────────────────────
  header("Done. Next steps");
  info(`  cd "${repoRoot}"`);
  info(`  pnpm dlx @devplusllc/harness watch --project ${decidedSlug}    # daemon`);
  if (envState.discord_token && envState.discord_guild) {
    info(
      `  pnpm dlx @devplusllc/harness run --project ${decidedSlug} --frontend discord`,
    );
  } else {
    info(
      `  # discord adapter not configured — using stub. Set DISCORD_BOT_TOKEN + DISCORD_GUILD_ID, then:`,
    );
    info(
      `  pnpm dlx @devplusllc/harness run --project ${decidedSlug} --frontend stub`,
    );
  }
  if (warnings.length > 0) {
    info("\nWarnings:");
    for (const w of warnings) info(`  ! ${w}`);
  }

  log.info(
    {
      repo_root: repoRoot,
      slug: decidedSlug,
      seeded: seed.written_files.length,
      collisions: seed.collisions.length,
      e2e: e2eChoice,
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
  repoRoot: string;
}): Record<string, unknown> {
  const detected_sensor_commands = args.detection.proposed_sensors.map((s) => ({
    id: s.id,
    command: s.command,
    args: s.args,
    applies_to: s.applies_to,
    reason: s.reason,
  }));

  return {
    version: 1,
    slug: args.decidedSlug,
    origin_url: args.detection.origin_url,
    stack_signatures: args.detection.stack_signatures.map((s) => s.kind),
    hook_capability: args.detection.hook_capability,
    start_command: args.detection.start_command,
    detected_sensor_commands,
    off_limits: DEFAULT_OFF_LIMITS,
    high_stakes_globs: [] as string[],
    project_globs: {
      route_handler_globs: [] as string[],
      dto_globs: [] as string[],
      generator_source_globs: [] as string[],
      high_stakes_globs: [] as string[],
    },
  };
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
