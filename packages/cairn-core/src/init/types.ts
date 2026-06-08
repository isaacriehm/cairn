/**
 * `cairn init` adoption wizard — detection types.
 *
 * Detection-driven, no stack profiles. Treats every project generically
 * and proposes per-sensor approval at adoption.
 */

/**
 * A stack id — OPEN string, not a closed union. Common ids: typescript,
 * python, ruby, go, rust, elixir, java, kotlin, csharp, php, dart, swift,
 * scala, clojure, haskell, cpp, zig, "unknown". The deterministic marker
 * table in `detect.ts` names the common ecosystems; anything it can't name
 * is left for the LLM mapper phase rather than coerced to a default.
 */
export type StackKind = string;

/** A single detected stack signature with the marker file that flagged it. */
export interface StackSignature {
  kind: StackKind;
  /** File or directory whose presence flagged this stack. */
  marker: string;
}

/** A sensor the cairn proposes adding to .cairn/config/sensors.yaml. */
export interface SensorProposal {
  id: string;
  /** Command + args. Run via child_process from the user tree. */
  command: string;
  args: string[];
  /** Stack signature(s) this sensor binds to. */
  applies_to: StackKind[];
  /** Why this sensor was proposed (file presence, config block, etc.). */
  reason: string;
  /** Whether running this sensor needs `pnpm install` / `pip install` / etc. */
  needs_install?: boolean;
}

export interface StartCommand {
  command: string;
  args: string[];
  /** Sub-package cwd — relative to the repo root. */
  cwd?: string;
  reason: string;
}

export type HookCapability = "claude-code" | "git-hooks" | "cli-only";

export interface DetectionResult {
  /** Repo root absolute path. */
  repo_root: string;
  /** Slug derived from package.json name OR git remote basename OR cwd basename. */
  project_slug: string;
  /** git origin URL when present. */
  origin_url: string | null;
  /** All matching stack signatures (may be empty for non-source repos). */
  stack_signatures: StackSignature[];
  /** Sensors the cairn proposes. Ordered by stack signature. */
  proposed_sensors: SensorProposal[];
  /** Best-guess start command for the dev server. */
  start_command: StartCommand | null;
  hook_capability: HookCapability;
  /** Optional environment readiness — advisory, never blocking. */
  environment: {
    claude_auth: boolean;
  };
  /**
   * True only when the operator is dogfooding Cairn against its own
   * source repo via the `CAIRN_SELF_ADOPT=1` escape hatch (Phase 1
   * detect sets this; otherwise the guard refuses adoption). Phases
   * 8 / 9 / 10 / 12 short-circuit when this is true so the recursive-
   * ingest scenario (Cairn's own docs / source comments / CLAUDE.md /
   * essay-class block strip) never runs against the source tree.
   */
  is_self_adopt?: boolean;
}
