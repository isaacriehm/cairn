/**
 * `cairn baseline` — re-run the synthetic-diff sensor sweep post-adoption.
 *
 * Phase 8 runs at adoption time but skips 9 sensors that need inputs the
 * pipeline can't supply yet (decision-assertions, invariant-suite,
 * attestation-cross-check, etc.). After adoption those sensors have
 * ground state to chew on, but there's no built-in way to re-run them.
 *
 * `cairn baseline` (default): re-run the same set Phase 8 ran — fast,
 * no LLM, useful for spot-checking after edits.
 *
 * `cairn baseline --force`: bypass `BASELINE_SKIP_IDS` so the post-init
 * sensors run too. Useful for an end-of-adoption review pass to surface
 * findings the day-1 sweep couldn't.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { cairnDir,
  defaultBaselineLanguages,
  detectStackSignatures,
  readMapperOutputFile,
  runBaselineAudit,
  type BaselineAuditResult,
  type ProjectGlobs,
} from "@isaacriehm/cairn-core";

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
    console.error(`cairn baseline: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!existsSync(cairnDir(repoRoot))) {
    console.error(
      `cairn baseline: ${repoRoot} is not cairn-adopted (no .cairn/). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
}

function loadGlobsFromConfig(repoRoot: string): ProjectGlobs {
  // Prefer the mapper output (richer coverage); fall back to .cairn/config.yaml.
  const mapper = readMapperOutputFile(repoRoot);
  if (mapper !== null) {
    return {
      route_handler_globs: mapper.output.route_handler_globs,
      dto_globs: mapper.output.dto_globs,
      generator_source_globs: mapper.output.generator_source_globs,
      high_stakes_globs: mapper.output.high_stakes_globs,
      off_limits: mapper.output.off_limits_globs,
    };
  }
  const cfgPath = cairnDir(repoRoot, "config.yaml");
  if (!existsSync(cfgPath)) return {};
  try {
    const parsed = parseYaml(readFileSync(cfgPath, "utf8")) as
      | Record<string, unknown>
      | null;
    if (parsed === null || typeof parsed !== "object") return {};
    const cfg = parsed as Record<string, unknown>;
    const globs: ProjectGlobs = {};
    const projectGlobs = cfg["project_globs"];
    if (typeof projectGlobs === "object" && projectGlobs !== null) {
      const pg = projectGlobs as Record<string, unknown>;
      for (const k of [
        "route_handler_globs",
        "dto_globs",
        "generator_source_globs",
        "high_stakes_globs",
      ] as const) {
        const v = pg[k];
        if (Array.isArray(v)) {
          (globs as Record<string, unknown>)[k] = v.filter(
            (x): x is string => typeof x === "string",
          );
        }
      }
    }
    const off = cfg["off_limits"];
    if (Array.isArray(off)) {
      globs.off_limits = off.filter((x): x is string => typeof x === "string");
    }
    return globs;
  } catch {
    return {};
  }
}

function renderResult(result: BaselineAuditResult, force: boolean): void {
  process.stdout.write(
    `  Files scanned: ${result.filesScanned}\n` +
      `  Total findings: ${result.findingsCount}\n\n`,
  );
}

export async function baselineCli(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "Usage: cairn baseline [--force] [--repo <path>]\n" +
        "  Re-run the synthetic-diff sensor sweep against the adopted project.\n",
    );
    process.exit(0);
  }
  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);
  const force = argv.includes("--force");
  const languages = defaultBaselineLanguages(detectStackSignatures(repoRoot).map((s) => s.kind as string));

  process.stdout.write(
    `  ⬡ cairn baseline${force ? " --force" : ""} — ${repoRoot}\n\n`,
  );
  const result = await runBaselineAudit({
    repoRoot,
    languages,
  });
  renderResult(result, force);
  process.exit(result.findingsCount > 0 ? 2 : 0);
}
