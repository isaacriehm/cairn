/**
 * Phase-ready surface relocation.
 *
 * `phase-ready-to-exit` events used to inject straight into the Stop
 * hook's `decision: block` reason. Claude Code labels every Stop
 * decision-block as "Stop hook error" in the operator UI — even when
 * the block carries informational Cairn context — which the operator
 * reads as a real failure. That visual signal is what we wanted to
 * avoid, so the surface moved off Stop entirely:
 *
 *   - Stop hook collects phase-ready hints from drained events as
 *     before, but writes them to
 *     `.cairn/sessions/<id>/phase-ready-pending.json` instead of
 *     emitting `decision: block`. If no other surface is pending,
 *     Stop returns `{continue: true}` and the operator sees no
 *     banner.
 *   - UserPromptSubmit hook, fired on the next operator prompt,
 *     reads the pending file, renders it as `additionalContext`,
 *     and deletes the file. Claude Code stitches the
 *     `additionalContext` straight into the model's next turn — no
 *     red banner, no `decision: block`.
 *
 * Idempotency for the phase-ready emission itself is handled upstream
 * in `task-link.ts` via the per-phase `ready_emitted` flag on
 * `phase_progress`. This module is purely the Stop → UPS shuttle.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

export interface PhaseReadyHint {
  mission_id: string;
  mission_title: string;
  phase_id: string;
  phase_title: string;
  exit_criteria: string;
}

interface PendingFile {
  ts: string;
  session_id: string;
  hints: PhaseReadyHint[];
}

function pendingPath(repoRoot: string, sessionId: string): string {
  return cairnDir(repoRoot,
    "sessions",
    sessionId,
    "phase-ready-pending.json",
  );
}

/**
 * Persist the hints the Stop hook collected so the next UPS hook can
 * inject them as additionalContext. Overwrites any prior pending file
 * for the session — the latest hint set wins (the operator hasn't
 * seen the old one yet so there's nothing to merge).
 */
export function writePhaseReadyPending(
  repoRoot: string,
  sessionId: string,
  hints: PhaseReadyHint[],
): void {
  if (hints.length === 0) return;
  const path = pendingPath(repoRoot, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: PendingFile = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      hints,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Read the pending file and delete it in one shot — UPS hook semantics
 * are "show once, then forget". When the file is missing or malformed
 * returns null so the caller can no-op cleanly.
 */
export function readAndConsumePhaseReadyPending(
  repoRoot: string,
  sessionId: string,
): PhaseReadyHint[] | null {
  const path = pendingPath(repoRoot, sessionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  const p = parsed as Partial<PendingFile>;
  if (!Array.isArray(p.hints) || p.hints.length === 0) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  try { unlinkSync(path); } catch { /* ignore */ }
  return p.hints as PhaseReadyHint[];
}

/**
 * Render the operator-facing phase-ready prompt. Keeps option labels
 * in plain English — no MCP tool-call syntax, no internal ids exposed
 * raw — and instructs the model to surface via `AskUserQuestion`.
 *
 * The mission/phase ids stay in the body for traceability but the
 * AskUserQuestion option labels themselves are human-readable phase
 * titles, not phase ids.
 */
export function renderPhaseReadyHint(hints: PhaseReadyHint[]): string {
  const h = hints[0];
  if (h === undefined) return "";

  const lines: string[] = [];
  lines.push(`## Cairn — phase ready to exit`);
  lines.push("");
  lines.push(`**Mission:** ${h.mission_title}`);
  lines.push(`**Phase:** ${h.phase_title}`);
  lines.push("");
  lines.push(`Exit criteria: ${h.exit_criteria}`);
  lines.push("");
  lines.push(
    "Surface this question to the operator via `AskUserQuestion`. Do NOT call `cairn_mission_advance` yourself — the operator's answer is the only valid input.",
  );
  lines.push("");
  lines.push(`> Phase \`${h.phase_title}\` looks done. Move on?`);
  lines.push(">");
  lines.push("> - `[a]` Mark phase done, advance to next phase");
  lines.push("> - `[b]` Keep working on this phase");
  lines.push("");
  lines.push(
    `On \`[a]\`, call \`cairn_mission_advance({phase_id: "${h.phase_id}", choice: "exit"})\`. On \`[b]\`, call \`cairn_mission_advance({phase_id: "${h.phase_id}", choice: "not_yet"})\`.`,
  );

  return lines.join("\n");
}
