/**
 * Phase 16 — `harness init` adoption wizard.
 *
 * Detection-driven, no stack profiles. Per operator decision 2026-05-02:
 * "should be agnostic, why are we shipping with profiles." Profiles bake
 * stack assumptions into the harness pkg; detection treats every project
 * generically and proposes per-sensor approval at adoption.
 */

export type StackKind =
  | "typescript"
  | "python"
  | "ruby"
  | "go"
  | "rust"
  | "elixir"
  | "unknown";

/** A single detected stack signature with the marker file that flagged it. */
export interface StackSignature {
  kind: StackKind;
  /** File or directory whose presence flagged this stack. */
  marker: string;
}

/** A sensor the harness proposes adding to .harness/config/sensors.yaml. */
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
  /** Sensors the harness proposes. Ordered by stack signature. */
  proposed_sensors: SensorProposal[];
  /** Best-guess start command for the dev server. */
  start_command: StartCommand | null;
  hook_capability: HookCapability;
  /** Optional environment readiness — advisory, never blocking. */
  environment: {
    claude_auth: boolean;
  };
}
