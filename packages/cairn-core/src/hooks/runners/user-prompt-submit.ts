/**
 * `cairn hook user-prompt-submit` — UserPromptSubmit hook.
 *
 * Claude Code's `@<path>` shorthand attaches file content to the
 * prompt directly, BYPASSING the Read tool — so the
 * PostToolUse(Read) read-enricher hook never fires for those files.
 * This hook fills the gap: it parses `@<path>` patterns from the
 * raw prompt, reads each file, scans for §INV-/§DEC- citations,
 * builds the same legend the read-enricher would have,
 * and emits it as `additionalContext`. Result: the model sees
 * the resolved citations alongside the attached file content,
 * matching the documented "bare symbols always resolve on Read"
 * contract regardless of attachment path.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveRepoRoot } from "../../session-start/index.js";
import { scanCitations, type ScannedCitations } from "../post-tool-use/citation-scanner.js";
import {
  getDecisionsLedger,
  getInvariantsLedger,
  getScopeIndexEntry,
} from "@isaacriehm/cairn-state";
import { buildLegend, type ScopeIndexHint } from "../post-tool-use/legend-builder.js";
import { appendTelemetry, readHookStdin } from "./payload.js";
import {
  readAndConsumePhaseReadyPending,
  renderPhaseReadyHint,
} from "./phase-ready-surface.js";
import {
  readAndConsumeAnnotatePending,
  renderAnnotateHint,
} from "./annotate-surface.js";
import { buildWorkingHeader } from "../../context/index.js";
import { getSeenFingerprint, setSeenFingerprint } from "../../session/index.js";

const MAX_FILE_BYTES = 512_000;
// Match `@<path>` only when `@` follows whitespace or is at start of
// prompt — filters out emails, twitter-style mentions, etc. Path
// chars: word, dot, slash, hyphen.
import { z } from "zod";

const AT_PATH_RE = /(?:^|\s)@([\w./-]+)/g;

const UserPromptSubmitPayloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  prompt: z.string().optional(),
}).passthrough();

type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;

interface UserPromptSubmitShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

function parsePayload(text: string): UserPromptSubmitPayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as UserPromptSubmitPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function emitShapeB(additionalContext: string): void {
  const out: UserPromptSubmitShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function extractAttachedPaths(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(AT_PATH_RE)) {
    const p = m[1];
    if (typeof p === "string" && p.length > 0) out.push(p);
  }
  return out;
}

function safeRead(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    const buf = readFileSync(absPath, "utf8");
    if (buf.length > MAX_FILE_BYTES) return buf.slice(0, MAX_FILE_BYTES);
    return buf;
  } catch {
    return null;
  }
}

export async function runUserPromptSubmitHook(): Promise<void> {
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const sessionId =
      typeof payload.session_id === "string" ? payload.session_id : null;

    const repoRoot = resolveRepoRoot(cwd);

    // Phase-ready surface: Stop hook stashed phase-ready hints in
    // `.cairn/sessions/<id>/phase-ready-pending.json` so we could
    // inject them here as `additionalContext` (no red "Stop hook
    // error" banner). Consume once — file is deleted on read so the
    // operator sees the prompt exactly once per Stop emission.
    let phaseReadyContext = "";
    if (repoRoot !== null && sessionId !== null && sessionId.length > 0) {
      try {
        const hints = readAndConsumePhaseReadyPending(repoRoot, sessionId);
        if (hints !== null && hints.length > 0) {
          phaseReadyContext = renderPhaseReadyHint(hints);
        }
      } catch {
        // best-effort — never block the prompt on this
      }
      // Stage-3 component capture-gate: consume the Stop hook's
      // annotate stash and fold it into the deferred surface so it
      // flows through every emit path below. Inject-only.
      try {
        const asks = readAndConsumeAnnotatePending(repoRoot, sessionId);
        if (asks !== null && asks.length > 0) {
          const annotateText = renderAnnotateHint(asks);
          phaseReadyContext = [phaseReadyContext, annotateText]
            .filter((s) => s.length > 0)
            .join("\n\n");
        }
      } catch {
        // best-effort
      }
    }

    // Working-context header (context engine, stage 1): inject a compact
    // active-task + mission + in-scope-id frame, deduped against this
    // session's last injection (per-session fingerprint, key
    // `working-header`). Only re-sent when it changed — unchanged frames
    // never re-bloat context. Prepended to EVERY emit path below; it is
    // the highest-value frame so it goes first.
    let headerCtx = "";
    if (repoRoot !== null && sessionId !== null && sessionId.length > 0) {
      try {
        const wh = buildWorkingHeader(repoRoot, sessionId);
        if (
          wh !== null &&
          getSeenFingerprint(repoRoot, sessionId, "working-header") !== wh.fingerprint
        ) {
          headerCtx = wh.text;
          setSeenFingerprint(repoRoot, sessionId, "working-header", wh.fingerprint);
        }
      } catch {
        // best-effort — never block the prompt on the header
      }
      appendTelemetry({
        repoRoot,
        sessionId,
        kind: "working-header",
        durationMs: 0,
        source: null,
        warnings: [],
        extra: { injected: headerCtx.length > 0 },
      });
    }
    const withHeader = (ctx: string): string =>
      [headerCtx, ctx].filter((s) => s.length > 0).join("\n\n");

    // Fast-path: no `@` token in prompt → emit header + phase-ready alone.
    if (prompt.length === 0 || !prompt.includes("@")) {
      emitShapeB(withHeader(phaseReadyContext));
      return;
    }

    if (repoRoot === null) {
      emitShapeB(withHeader(phaseReadyContext));
      return;
    }

    const paths = extractAttachedPaths(prompt);
    if (paths.length === 0) {
      emitShapeB(withHeader(phaseReadyContext));
      return;
    }

    // Aggregate citations across all attached files. Filter to existing
    // files — non-existent `@`-mentions are typically not file refs.
    const aggregated: ScannedCitations = {
      invariants: [],
      decisions: [],
    };
    let firstHitRel: string | null = null;
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : resolve(repoRoot, p);
      const content = safeRead(abs);
      if (content === null) continue;
      const matches = scanCitations(content);
      const hit =
        matches.invariants.length > 0 ||
        matches.decisions.length > 0;
      if (!hit) continue;
      if (firstHitRel === null) {
        const rel = relative(repoRoot, abs);
        if (!rel.startsWith("..") && rel.length > 0) {
          firstHitRel = rel.replace(/\\/g, "/");
        }
      }
      aggregated.invariants.push(...matches.invariants);
      aggregated.decisions.push(...matches.decisions);
    }

    if (
      aggregated.invariants.length === 0 &&
      aggregated.decisions.length === 0
    ) {
      emitShapeB(withHeader(phaseReadyContext));
      return;
    }

    const cachedEntry =
      firstHitRel !== null ? getScopeIndexEntry(repoRoot, firstHitRel) : null;
    const scopeHint: ScopeIndexHint | null =
      cachedEntry !== null
        ? {
            decisions: cachedEntry.decisions,
            invariants: cachedEntry.invariants,
          }
        : null;

    const invariantsLedger = getInvariantsLedger(repoRoot);
    const decisionsLedger = getDecisionsLedger(repoRoot);

    const legend = buildLegend(
      aggregated,
      invariantsLedger,
      decisionsLedger,
      scopeHint,
    );

    // Stitch header → phase-ready → legend so the operator sees the
    // highest-priority surfaces first.
    const combined = [headerCtx, phaseReadyContext, legend ?? ""]
      .filter((s) => s.length > 0)
      .join("\n\n");
    emitShapeB(combined);
  } catch {
    try {
      emitShapeB("");
    } catch {
      // last resort
    }
  }
}
