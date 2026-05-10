/**
 * State persistence for the MCP-native init pipeline.
 *
 * State lives at `.cairn/init-state.json` once that directory exists
 * (after phase 1-detect creates it). Before that, no state file is
 * written — `readPhaseState` returns null and the orchestrator starts
 * fresh at "1-detect". After the final phase succeeds the state file
 * is removed by `clearPhaseState`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PHASE_IDS, type PhaseState, type PhaseId } from "./types.js";

/** Filename relative to repoRoot. */
export const INIT_STATE_PATH = join(".cairn", "init-state.json");

export function phaseStateAbsPath(repoRoot: string): string {
  return join(repoRoot, INIT_STATE_PATH);
}

/** Read the on-disk init state. Returns null if missing or unreadable. */
export function readPhaseState(repoRoot: string): PhaseState | null {
  const abs = phaseStateAbsPath(repoRoot);
  if (!existsSync(abs)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  if (!isPhaseState(parsed)) return null;
  return parsed;
}

/** Atomically write the init state. Creates `.cairn/` if needed. */
export function writePhaseState(state: PhaseState): string {
  const abs = phaseStateAbsPath(state.repoRoot);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  // POSIX rename is atomic on the same filesystem (always true here:
  // tmp + final are in the same .cairn/ dir).
  renameSync(tmp, abs);
  return abs;
}

/** Remove the init state file. No-op if it doesn't exist. */
export function clearPhaseState(repoRoot: string): void {
  rmSync(phaseStateAbsPath(repoRoot), { force: true });
}

function isPhaseId(v: unknown): v is PhaseId {
  return typeof v === "string" && (PHASE_IDS as readonly string[]).includes(v);
}

function isStringOrUndef(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isPhaseState(x: unknown): x is PhaseState {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o["schemaVersion"] !== 2) return false;
  if (typeof o["repoRoot"] !== "string") return false;
  if (!isPhaseId(o["currentPhase"])) return false;
  if (typeof o["outputs"] !== "object" || o["outputs"] === null) return false;
  if (!isStringOrUndef(o["answer"])) return false;
  if (typeof o["startedAt"] !== "string") return false;
  return true;
}
