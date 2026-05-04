/**
 * Phase 12 — multi-developer enforcement install.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 + §6 Phase 12.
 *
 * Idempotent. Runs once during `harness init` after the .harness/ skeleton
 * is seeded. Wires up the per-package-manager bootstrap hook so every clone
 * runs `harness join` automatically:
 *
 *   - Node projects: `package.json` `scripts.prepare` += "harness join || true"
 *   - Python (pyproject.toml): emits a JOIN-extension hint for the operator
 *   - Rust / Go / generic: emits the same hint — these toolchains don't
 *     have an install-time hook surface, so JOIN.md is the path
 *
 * The hint is captured in the result so the visual layer can render it once
 * inline; nothing is written outside `package.json` automatically.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREPARE_SCRIPT_FRAGMENT = "harness join || true";

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
    const patch = patchPackageJsonPrepare(pkgJson, args.dryRun === true);
    steps.push(patch.step);
  }
  const pyproject = join(repoRoot, "pyproject.toml");
  if (existsSync(pyproject)) {
    hostKinds.push("pyproject-toml");
    manualHints.push(
      "pyproject.toml detected — add a hatch / poetry hook that runs `harness join` after env install (no automatic patch)",
    );
  }
  if (existsSync(join(repoRoot, "Makefile"))) {
    hostKinds.push("makefile");
    manualHints.push(
      "Makefile detected — add `harness join || true` to your `setup` / `install` target so contributors bootstrap on first build",
    );
  }
  if (existsSync(join(repoRoot, "justfile"))) {
    hostKinds.push("justfile");
    manualHints.push(
      "justfile detected — add `harness join || true` to your `setup` recipe",
    );
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    hostKinds.push("cargo-toml");
    manualHints.push(
      "Cargo.toml detected — Cargo has no install-time hook; rely on .harness/JOIN.md for new contributors",
    );
  }
  if (existsSync(join(repoRoot, "go.mod"))) {
    hostKinds.push("go-mod");
    manualHints.push(
      "go.mod detected — Go has no install-time hook; rely on .harness/JOIN.md for new contributors",
    );
  }
  if (hostKinds.length === 0) {
    hostKinds.push("none");
    manualHints.push(
      "No package-manager manifest detected — JOIN.md is the only on-ramp; share it with new contributors",
    );
  }

  const preparePatched = steps.some(
    (s) => s.step === "patch-package-prepare" && s.status === "ok",
  );

  return { hostKinds, preparePatched, manualHints, steps };
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
        detail: "prepare script already runs `harness join`",
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
