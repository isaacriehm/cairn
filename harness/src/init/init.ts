/**
 * `harness init` orchestrator.
 *
 * Three steps with two operator dialogs (L44 cap):
 *   1. Detect → print summary → one "proceed?" dialog
 *   2. Seed `.harness/` + .archive/ from templates with `<project_name>`
 *      substituted. Write `.harness/config.yaml` carrying the
 *      project-specific overlay (slug, origin, start_command,
 *      hook_capability, e2e_setup, detected_sensors).
 *   3. Mirror init (skippable). E2E setup dialog → now / defer / skip.
 *
 * Advisory environment warnings (whisper, ollama, discord, claude) print
 * inline; they never block.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ensureMirror, normalizeProjectName } from "../mirror/index.js";
import { logger } from "../logger.js";
import { detectAll } from "./detect.js";
import { done, freeTextWithDefault, header, info, squareIntoSquareHole, type PromptMode } from "./prompts.js";
import { seedHarnessLayout } from "./seed.js";
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
    info(
      "\nE2E setup chosen `now` — run these in your project shell when convenient:",
    );
    info(`  pnpm dlx @devplusllc/harness setup:uat-browsers`);
    info(`  pnpm dlx @devplusllc/harness setup:uat-sql --build-binding`);
    info(`  pnpm dlx @devplusllc/harness setup:uat-docker`);
    info(
      "(The init wizard does not invoke them automatically yet — that lands in P16.x.)",
    );
  }

  // ── Step 5: next-steps ─────────────────────────────────────────────
  header("Done. Next steps");
  info(`  cd "${repoRoot}"`);
  info(`  pnpm dlx @devplusllc/harness watch --project ${decidedSlug}    # daemon`);
  if (detection.environment.discord_token && detection.environment.discord_guild) {
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
