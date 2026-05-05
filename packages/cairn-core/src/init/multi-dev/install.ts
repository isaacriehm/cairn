/**
 * Phase 12 — multi-developer enforcement detection.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 + §6 Phase 12.
 *
 * Idempotent. Runs once during `cairn init` after the .cairn/ skeleton
 * is seeded. Detects the package manager(s) in use and emits per-host
 * JOIN.md hints for new contributors. The plugin bundle is the
 * primary delivery mechanism; the Claude Code SessionStart hook
 * surfaces the per-clone bootstrap banner the moment a contributor
 * opens an unbootstrapped clone, so phase 12 no longer auto-patches
 * `package.json` `prepare` (would fail noisily when no global `cairn`
 * binary is on PATH — see PLUGIN_ARCHITECTURE §17 Layer 4).
 *
 * `patchPackageJsonPrepare` remains exported for explicit operator-
 * driven wiring; phase 12 itself never calls it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREPARE_SCRIPT_FRAGMENT = "cairn join || true";

export type MultiDevHostKind =
  | "node-package-json"
  | "pyproject-toml"
  | "makefile"
  | "justfile"
  | "cargo-toml"
  | "go-mod"
  | "none";

export interface MultiDevInstallStep {
  step: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

export interface MultiDevInstallResult {
  hostKinds: MultiDevHostKind[];
  /**
   * Always false in v0.2.0+ — phase 12 no longer auto-patches
   * `package.json`. Field retained on the result type for downstream
   * consumers (skills, smokes) that branch on it.
   */
  preparePatched: boolean;
  manualHints: string[];
  steps: MultiDevInstallStep[];
}

export interface InstallMultiDevArgs {
  repoRoot: string;
  /** Skip filesystem writes — used by smokes. */
  dryRun?: boolean;
}

export function installMultiDev(args: InstallMultiDevArgs): MultiDevInstallResult {
  const repoRoot = args.repoRoot;
  const hostKinds: MultiDevHostKind[] = [];
  const manualHints: string[] = [];
  const steps: MultiDevInstallStep[] = [];

  const pkgJson = join(repoRoot, "package.json");
  if (existsSync(pkgJson)) {
    hostKinds.push("node-package-json");
    manualHints.push(
      "package.json detected — Claude Code contributors get the SessionStart bootstrap banner; CLI-only contributors run `cairn join` once after `npm install`",
    );
  }
  const pyproject = join(repoRoot, "pyproject.toml");
  if (existsSync(pyproject)) {
    hostKinds.push("pyproject-toml");
    manualHints.push(
      "pyproject.toml detected — add a hatch / poetry hook that runs `cairn join` after env install (no automatic patch)",
    );
  }
  if (existsSync(join(repoRoot, "Makefile"))) {
    hostKinds.push("makefile");
    manualHints.push(
      "Makefile detected — add `cairn join || true` to your `setup` / `install` target so contributors bootstrap on first build",
    );
  }
  if (existsSync(join(repoRoot, "justfile"))) {
    hostKinds.push("justfile");
    manualHints.push(
      "justfile detected — add `cairn join || true` to your `setup` recipe",
    );
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    hostKinds.push("cargo-toml");
    manualHints.push(
      "Cargo.toml detected — Cargo has no install-time hook; rely on .cairn/JOIN.md for new contributors",
    );
  }
  if (existsSync(join(repoRoot, "go.mod"))) {
    hostKinds.push("go-mod");
    manualHints.push(
      "go.mod detected — Go has no install-time hook; rely on .cairn/JOIN.md for new contributors",
    );
  }
  if (hostKinds.length === 0) {
    hostKinds.push("none");
    manualHints.push(
      "No package-manager manifest detected — JOIN.md is the only on-ramp; share it with new contributors",
    );
  }

  steps.push({
    step: "detect-host-kinds",
    status: "ok",
    detail: `detected ${hostKinds.join(", ")}`,
  });

  return { hostKinds, preparePatched: false, manualHints, steps };
}

/* -------------------------------------------------------------------------- */
/* package.json patcher                                                       */
/* -------------------------------------------------------------------------- */

interface PatchOutcome {
  step: MultiDevInstallStep;
}

export function patchPackageJsonPrepare(pkgPath: string, dryRun: boolean): PatchOutcome {
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch (err) {
    return {
      step: {
        step: "patch-package-prepare",
        status: "error",
        detail: `read ${pkgPath} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      step: {
        step: "patch-package-prepare",
        status: "error",
        detail: `parse ${pkgPath} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const scriptsRaw = parsed["scripts"];
  const scripts: Record<string, string> =
    typeof scriptsRaw === "object" && scriptsRaw !== null
      ? (scriptsRaw as Record<string, string>)
      : {};
  const existingPrepare = typeof scripts["prepare"] === "string" ? scripts["prepare"] : "";

  if (existingPrepare.includes(PREPARE_SCRIPT_FRAGMENT)) {
    return {
      step: {
        step: "patch-package-prepare",
        status: "skipped",
        detail: "prepare script already runs `cairn join`",
      },
    };
  }

  const newPrepare =
    existingPrepare.length === 0
      ? PREPARE_SCRIPT_FRAGMENT
      : `${PREPARE_SCRIPT_FRAGMENT} && ${existingPrepare}`;
  scripts["prepare"] = newPrepare;
  parsed["scripts"] = scripts;

  if (dryRun) {
    return {
      step: {
        step: "patch-package-prepare",
        status: "ok",
        detail: `(dry-run) would set scripts.prepare = "${newPrepare}"`,
      },
    };
  }

  // Preserve trailing newline if the original had one.
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  // Heuristic indent: 2 spaces matches npm / yarn / pnpm convention.
  const out = `${JSON.stringify(parsed, null, 2)}${trailingNewline}`;
  try {
    writeFileSync(pkgPath, out, "utf8");
  } catch (err) {
    return {
      step: {
        step: "patch-package-prepare",
        status: "error",
        detail: `write ${pkgPath} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  return {
    step: {
      step: "patch-package-prepare",
      status: "ok",
      detail: `scripts.prepare = "${newPrepare}"`,
    },
  };
}
