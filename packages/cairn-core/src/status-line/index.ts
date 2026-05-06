/**
 * Status-line module.
 *
 * The plugin's SessionStart hook writes `.cairn/sessions/<id>/status.json`
 * and Claude Code's status_line hook invokes `cairn status-line` (which
 * reads the same file via `readStatusForCLI`).
 *
 * Spec: PLUGIN_ARCHITECTURE §7 (per-session state partition);
 * docs/STATUS_LINE_SPEC.md (format).
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
  decisions_in_scope: number;
  invariants_in_scope: number;
  task_state: TaskState;
  task_id: string | null;
  task_module: string | null;
  gc_running: boolean;
  attention_count: number;
  bypass_count: number;
  last_run_result: "succeeded" | "failed" | null;
  last_run_at: string | null;
}

export {
  defaultStatusJson,
  statusJsonPath,
  writeStatusJson,
} from "./writer.js";
export { readStatusForCLI } from "./reader.js";
export { formatStatus, renderCtxMeter, type CtxMeterInput } from "./format.js";
