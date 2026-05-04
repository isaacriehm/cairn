/**
 * Status-line module.
 *
 * The harness daemon writes `~/.local/harness/state/<slug>/status.json` and
 * Claude Code's status_line hook invokes `harness status-line` to render it.
 *
 * See docs/STATUS_LINE_SPEC.md.
 */

export type TaskState =
  | "idle"
  | "running"
  | "queued"
  | "tightening"
  | "sensing"
  | "reviewing"
  | "backprop";

export interface StatusJson {
  /** ISO timestamp of last write. */
  updated_at: string;
  daemon_alive: boolean;
  ctx_tokens_used: number;
  ctx_tokens_budget: number;
  decisions_in_scope: number;
  invariants_in_scope: number;
  task_state: TaskState;
  task_module: string | null;
  gc_running: boolean;
  attention_count: number;
  last_run_result: "succeeded" | "failed" | null;
  last_run_at: string | null;
}

export {
  defaultStatusJson,
  writeStatusJson,
  writeStatusJsonForSlug,
} from "./writer.js";
export { readStatusForCLI } from "./reader.js";
export { formatStatus } from "./format.js";
