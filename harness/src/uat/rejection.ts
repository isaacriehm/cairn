/**
 * UAT rejection capture + retry remediation.
 *
 * Per UAT_PIPELINE.md §6:
 *   1. Adapter posts: "🔴 Rejected. What's wrong? A/B/C/D".
 *   2. Operator picks category + supplies free text or voice URL.
 *   3. If voice URL: Whisper transcribes via existing voice/transcribeUrl.
 *   4. Result is a structured `UatRejection`.
 *   5. Orchestrator writes `rejection.yaml` under the run's UAT dir.
 *   6. Implementer is re-spawned on the next attempt with the rejection
 *      formatted as remediation context.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { transcribeUrl } from "../voice/transcribe.js";
import type { FrontendAdapter } from "../frontend/types.js";
import { uatDirFor } from "./bundle.js";
import type { UatRejection, UatSummary } from "./types.js";

const log = logger("uat.rejection");

const REJECTION_DIALOG_TIMEOUT_MS = 86_400_000; // 24h per UAT_PIPELINE §9

const CATEGORY_LABEL: Record<UatRejection["category"], string> = {
  A: "Feature missing entirely",
  B: "UI / copy issue (specify in screenshot)",
  C: "Wrong behavior (describe in voice/text)",
  D: "Other",
};

function isCategoryChoice(s: string): s is UatRejection["category"] {
  return s === "A" || s === "B" || s === "C" || s === "D";
}

/** Detect an http(s) audio URL anywhere in `text`. */
export function extractAudioUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(https?:\/\/\S+\.(?:mp3|ogg|wav|m4a|webm|aac|flac))/i);
  return m?.[1];
}

export interface CaptureUatRejectionArgs {
  adapter: FrontendAdapter;
  runId: string;
  taskId: string;
  /** Optional initial reason from `adapter.requestApproval`'s reject response. */
  initialReason?: string;
  /** Channel id to thread the dialog into when supported by the adapter. */
  channelId?: string;
  /**
   * Override the dialog timeout. Default 24h per UAT_PIPELINE §9 timeouts.
   * Tests / smokes pass a short value so the stub adapter resolves quickly.
   */
  timeoutMs?: number;
}

/**
 * Run the post-reject A/B/C/D dialog, optionally transcribe a voice URL,
 * and return the structured `UatRejection`. Voice transcription is
 * best-effort: if Whisper isn't available, the URL is preserved in the
 * operator_note but voice_transcript stays unset.
 */
export async function captureUatRejection(args: CaptureUatRejectionArgs): Promise<UatRejection> {
  const dialog = await args.adapter.requestDialog({
    bundleId: `uat-reject-${args.runId}`,
    prompt: [
      "🔴 Rejected. What's wrong?",
      "(Reply with a voice-note URL ending in .mp3 / .m4a / .ogg / .wav / .webm to attach voice context — Whisper will transcribe it.)",
    ].join("\n"),
    choices: [
      { id: "A", label: CATEGORY_LABEL.A },
      { id: "B", label: CATEGORY_LABEL.B },
      { id: "C", label: CATEGORY_LABEL.C },
      { id: "D", label: CATEGORY_LABEL.D },
    ],
    ...(args.channelId !== undefined ? { channelId: args.channelId } : {}),
    timeoutMs: args.timeoutMs ?? REJECTION_DIALOG_TIMEOUT_MS,
  });

  const choice = isCategoryChoice(dialog.choiceId) ? dialog.choiceId : "D";
  const freeText = dialog.freeText ?? "";
  const initial = args.initialReason ?? "";
  const note = [initial, freeText].filter((s) => s.trim().length > 0).join("\n");

  // Voice URL detection — search both the dialog free text and the initial
  // reject reason. Operator might paste it in either place.
  const voiceUrl = extractAudioUrl(freeText) ?? extractAudioUrl(initial);
  let voiceTranscript: string | undefined;
  if (voiceUrl) {
    try {
      const result = await transcribeUrl(voiceUrl);
      voiceTranscript = result.text.trim();
      log.info({ run_id: args.runId, voice_url: voiceUrl, chars: voiceTranscript.length }, "voice transcribed");
    } catch (err) {
      log.warn(
        { err: String(err), url: voiceUrl, run_id: args.runId },
        "voice transcription failed; preserving URL in operator_note",
      );
    }
  }

  return {
    category: choice,
    operator_note: note,
    ...(voiceTranscript !== undefined ? { voice_transcript: voiceTranscript } : {}),
    rejected_at: new Date().toISOString(),
  };
}

export interface WriteRejectionYamlArgs {
  repoRoot: string;
  runId: string;
  rejection: UatRejection;
  summary: UatSummary;
}

/** Write `rejection.yaml` under the run's UAT directory. */
export async function writeRejectionYaml(args: WriteRejectionYamlArgs): Promise<string> {
  const dir = uatDirFor(args.repoRoot, args.runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "rejection.yaml");
  const failedAcs = args.summary.acceptance_results
    .filter((r) => r.status === "fail")
    .map((r) => ({ id: r.id, text: r.text, reason: r.failure_reason ?? null }));
  const body: Record<string, unknown> = {
    run_id: args.runId,
    task_id: args.summary.task_id,
    rejected_at: args.rejection.rejected_at,
    category: args.rejection.category,
    category_label: CATEGORY_LABEL[args.rejection.category],
    operator_note: args.rejection.operator_note,
    voice_transcript: args.rejection.voice_transcript ?? null,
    referenced_screenshots: args.rejection.referenced_screenshots ?? [],
    failed_acceptance_criteria: failedAcs,
  };
  await writeFile(path, stringifyYaml(body), "utf8");
  log.info({ run_id: args.runId, path, category: args.rejection.category }, "rejection.yaml written");
  return path;
}

export interface UatRejectionRemediationArgs {
  rejection: UatRejection;
  summary: UatSummary;
  attempt: number;
  maxAttempts: number;
}

/**
 * Format the operator's rejection as agent-prompt-shaped retry context.
 * Tone matches Phase 9 + 10 remediation: lead with what failed, then the
 * concrete actions the implementer should take, framed by the rejection
 * category.
 */
export function formatUatRejectionRemediation(args: UatRejectionRemediationArgs): string {
  const lines: string[] = [];
  lines.push("## Operator rejected the UAT bundle");
  lines.push("");
  lines.push(
    `On attempt ${args.attempt - 1} the operator rejected the run via UAT. This is retry attempt ${args.attempt} of ${args.maxAttempts}.`,
  );
  lines.push("");
  lines.push(`**Category:** ${args.rejection.category} — ${CATEGORY_LABEL[args.rejection.category]}`);
  if (args.rejection.operator_note.trim().length > 0) {
    lines.push("");
    lines.push("**Operator note:**");
    lines.push("");
    lines.push(args.rejection.operator_note.trim());
  }
  if (args.rejection.voice_transcript) {
    lines.push("");
    lines.push("**Voice transcript:**");
    lines.push("");
    lines.push(args.rejection.voice_transcript);
  }

  const fails = args.summary.acceptance_results.filter((r) => r.status === "fail");
  if (fails.length > 0) {
    lines.push("");
    lines.push("**Acceptance criteria that did not pass in the prior UAT:**");
    lines.push("");
    for (const f of fails) {
      const reason = f.failure_reason ? ` — ${f.failure_reason}` : "";
      lines.push(`- ${f.id} (${f.probe_kind}): ${f.text}${reason}`);
    }
  }

  lines.push("");
  lines.push("## What to do");
  lines.push("");
  switch (args.rejection.category) {
    case "A":
      lines.push(
        "Feature missing entirely. The previous attempt did not deliver the requested capability. Re-read the tightened spec, identify what's missing, and ship a complete delta — do not regenerate from scratch unless your prior diff is contradictory.",
      );
      break;
    case "B":
      lines.push(
        "UI / copy issue. Locate the visual or textual problem the operator described and fix it specifically. Do NOT regenerate the whole feature; ship a tight delta to address the operator's note + any referenced screenshots.",
      );
      break;
    case "C":
      lines.push(
        "Wrong behavior. The implementation runs but produces the wrong result. Diagnose why each failed acceptance criterion did not pass, fix the underlying behavior, and verify locally before re-emitting attestation. Per-AC failure reasons above are concrete; do not paper over them.",
      );
      break;
    case "D":
      lines.push(
        "Other / mixed concern. Read the operator note (and any voice transcript) carefully and address what's described. If the note is itself ambiguous, emit a `blocked_by:` block instead of a partial diff.",
      );
      break;
  }

  lines.push("");
  lines.push(
    "Re-emit your `attestation:` YAML at end of reply with corrected `delivered`/`files_touched`/`todos_introduced`/`stubs_introduced` counts. Do NOT re-introduce any pattern flagged in `.harness/config/stub-patterns.yaml`.",
  );
  return lines.join("\n");
}
