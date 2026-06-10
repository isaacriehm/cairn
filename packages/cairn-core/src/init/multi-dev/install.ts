/**
 * Phase 13 — multi-developer enforcement detection.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 + §6 Phase 13.
 *
 * Idempotent. Runs once during `cairn init` after the .cairn/ skeleton
 * is seeded. Detects the package manager(s) in use and emits per-host
 * JOIN.md hints for new contributors. The plugin bundle is the
 * primary delivery mechanism; the Claude Code SessionStart hook
 * surfaces the per-clone bootstrap banner for unbootstrapped clones.
 * Phase 13 does not auto-patch `package.json` `prepare`.
 *
 * `patchPackageJsonPrepare` is exported for explicit operator-driven
 * wiring; phase 13 itself never calls it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGhost } from "@isaacriehm/cairn-state";
import { installCairnRuleAndImport } from "../claude-rule.js";

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
  /** Always false — phase 13 does not auto-patch `package.json`. */
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

  // Ghost is single-operator by design (§3.4, §9): there are no teammates, and
  // JOIN.md / the `.claude/rules/cairn.md` import are never written (they'd be
  // a tracked-source leak). So the whole multi-dev onboarding surface — per-host
  // hints ("rely on .cairn/JOIN.md for new contributors"), the package-manager
  // detection, and the rule-import wiring — is suppressed. (The rule import is
  // also guarded inside `installCairnRuleAndImport`; this is the belt over that
  // suspenders, and it kills the misleading hints too.)
  if (isGhost(repoRoot)) {
    return {
      hostKinds: ["none"],
      preparePatched: false,
      manualHints: [
        "ghost mode — single-operator; multi-dev onboarding (JOIN.md, per-host hints, teammate rule import) is suppressed by design",
      ],
      steps: [
        {
          step: "multi-dev-suppressed-ghost",
          status: "skipped",
          detail: "ghost is single-operator — no teammate onboarding artifacts",
        },
      ],
    };
  }

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

  // Plugin-absent onboarding. Write `.claude/rules/cairn.md` and wire the
  // `@`-import into the auto-loaded memory file (CLAUDE.md) so teammates
  // who clone this repo WITHOUT the Cairn plugin still see the install
  // notice on their first turn. Without the import the rule is orphaned —
  // Claude Code does not auto-load `.claude/rules/*` on its own, so the
  // fallback never fires (the failure that motivated this).
  if (args.dryRun === true) {
    steps.push({
      step: "wire-cairn-rule-import",
      status: "skipped",
      detail: "dry-run",
    });
  } else {
    try {
      const res = installCairnRuleAndImport(repoRoot);
      steps.push({
        step: "wire-cairn-rule-import",
        status: "ok",
        detail: `rule ${res.ruleWritten ? "written" : "current"}; import ${
          res.changed ? `added to ${res.file}` : "already present"
        }`,
      });
    } catch (err) {
      steps.push({
        step: "wire-cairn-rule-import",
        status: "error",
        detail: `failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

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
