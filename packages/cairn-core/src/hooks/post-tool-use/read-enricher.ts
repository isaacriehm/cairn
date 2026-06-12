/**
 * `cairn hook read-enrich` — PostToolUse hook on the Read tool.
 *
 * Scans the file content the agent just read for cairn citation
 * patterns (`§INV-<hash>`, `§DEC-<hash>`) and prepends a legend block to
 * Shape-B `additionalContext`.
 *
 * This hook is critical for "Honest Agent" context continuity — it
 * ensures that if an agent reads a file carrying a bare cite, it
 * immediately sees the definition and rationale for that cite without
 * having to manually fetch the DEC/INV artifact.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod";
import {
  componentsInScope,
  getDecisionsLedger,
  getInvariantsLedger,
  getScopeIndexEntry,
  hasComponentConfig,
  loadComponentsConfig,
} from "@isaacriehm/cairn-state";
import type {
  ComponentLedgerEntry,
  LedgerSnapshot,
  NormalizedComponentsConfig,
  ScopeIndexEntry,
} from "@isaacriehm/cairn-state";
import {
  readHookStdin,
  parseHookPayload,
  emitShapeB,
  appendTelemetry,
} from "../runners/payload.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { scanCitations, type ScannedCitations } from "./citation-scanner.js";
import { buildLegend } from "./legend-builder.js";
import { filterUnshownIds, markShownIds } from "../../session/index.js";
import { logger } from "../../logger.js";

const MAX_CONTENT_BYTES = 512_000;
const BINARY_SAMPLE_BYTES = 1024;
const BINARY_THRESHOLD = 0.05;

const ClaudePostToolUsePayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.object({
    file_path: z.string().optional(),
  }).optional(),
  tool_response: z.object({
    content: z.string().optional(),
    text: z.string().optional(),
    output: z.string().optional(),
    file: z.object({
      content: z.string().optional(),
      text: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type ClaudePostToolUsePayload = z.infer<typeof ClaudePostToolUsePayloadSchema>;

interface PostToolUseShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

const log = logger("hooks.post-tool-use.read-enricher");

/**
 * Hook entry point.
 */
export async function runReadEnricher(): Promise<void> {
  const ts = new Date().toISOString();
  let outcome: Record<string, unknown> = { skip: "unknown" };
  let repoRootForTrace: string | null = null;
  let sessionForTrace: string | null = null;
  try {
    const raw = await readHookStdin();
    const payload = parsePayload(raw);
    sessionForTrace = payload.session_id ?? null;

    if (payload.tool_name !== "Read") {
      outcome = { skip: "non-read-tool", tool_name: payload.tool_name };
      emitShapeB("", "PostToolUse");
      return;
    }
    const filePath = payload.tool_input?.file_path;
    const content = pickContent(payload.tool_response);
    if (filePath === undefined || content === undefined || content.length === 0) {
      outcome = {
        skip: "no-content",
        file_path: filePath ?? null,
        content_present: content !== undefined,
        content_chars: content?.length ?? 0,
      };
      emitShapeB("", "PostToolUse");
      return;
    }

    const cwd = payload.cwd ?? process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    repoRootForTrace = repoRoot;
    if (repoRoot === null) {
      outcome = { skip: "not-adopted", cwd };
      emitShapeB("", "PostToolUse");
      return;
    }

    const relPath = relative(repoRoot, resolve(cwd, filePath));
    if (isBinary(content)) {
      outcome = { skip: "binary", path: relPath };
      emitShapeB("", "PostToolUse");
      return;
    }

    const sessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : null;

    const citations = scanCitations(content);
    const scopeEntry = getScopeIndexEntry(repoRoot, relPath);
    const decisionsLedger = getDecisionsLedger(repoRoot);
    const invariantsLedger = getInvariantsLedger(repoRoot);

    // Stage-2 dedup (D13): the stage-1 working header carries the
    // persistent in-scope id INDEX, so the enricher renders each cited
    // DEC/INV BODY at most once per session. Re-reads of the same file
    // no longer re-inject the (bulky) title lines.
    const citedIds = [
      ...citations.decisions.map((d) => d.id),
      ...citations.invariants.map((i) => i.id),
    ];
    const freshIds =
      sessionId !== null
        ? new Set(filterUnshownIds(repoRoot, sessionId, citedIds))
        : new Set(citedIds);
    const freshCitations: ScannedCitations = {
      decisions: citations.decisions.filter((d) => freshIds.has(d.id)),
      invariants: citations.invariants.filter((i) => freshIds.has(i.id)),
    };

    const legend = buildLegend(
      freshCitations,
      invariantsLedger,
      decisionsLedger,
      scopeEntry,
    );

    // Stage-2 component slice (D17): when the agent reads a file under a
    // component dir, attach the entitled inventory (name · category ·
    // purpose · [S]) once per component per session — replacing the
    // agent's need to classify "UI work" and call components_in_scope.
    let componentSlice = "";
    const shownComponentKeys: string[] = [];
    try {
      const config = loadComponentsConfig(repoRoot);
      if (hasComponentConfig(config) && fileInComponentDir(config, relPath)) {
        const scope = componentsInScope(repoRoot, [relPath]);
        const keys = scope.components.map((c) => `comp:${c.name}`);
        const freshCompKeys =
          sessionId !== null
            ? new Set(filterUnshownIds(repoRoot, sessionId, keys))
            : new Set(keys);
        const freshComponents = scope.components.filter((c) =>
          freshCompKeys.has(`comp:${c.name}`),
        );
        if (freshComponents.length > 0) {
          componentSlice = renderComponentSlice(freshComponents);
          for (const c of freshComponents) shownComponentKeys.push(`comp:${c.name}`);
        }
      }
    } catch {
      // component config is optional — never block the read on it
    }

    // Mark shown AFTER building so a crash before this point leaves the
    // ids un-shown (they surface on the next read instead of vanishing).
    if (sessionId !== null) {
      const toMark = [...freshIds, ...shownComponentKeys];
      if (toMark.length > 0) markShownIds(repoRoot, sessionId, toMark);
    }

    const combined = [legend ?? "", componentSlice]
      .filter((s) => s.length > 0)
      .join("\n\n");

    outcome = {
      ok: true,
      path: relPath,
      citations: {
        invariants: citations.invariants.length,
        decisions: citations.decisions.length,
        fresh: freshCitations.invariants.length + freshCitations.decisions.length,
      },
      components_shown: shownComponentKeys.length,
      legend_chars: combined.length,
    };

    emitShapeB(combined, "PostToolUse");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = { error: message };
    log.error({ err: message }, "read-enricher hook failed");
    emitShapeB("", "PostToolUse");
  } finally {
    if (repoRootForTrace !== null) {
      appendTelemetry({
        repoRoot: repoRootForTrace,
        sessionId: sessionForTrace,
        kind: "read-enrich",
        durationMs: Date.now() - Date.parse(ts),
        source: "hook",
        warnings: [],
        extra: outcome,
      });
    }
  }
}

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const raw: unknown = JSON.parse(text);
    const result = ClaudePostToolUsePayloadSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function pickContent(
  resp: ClaudePostToolUsePayload["tool_response"],
): string | undefined {
  if (resp === undefined) return undefined;
  // Claude Code's Read tool wraps the body as `tool_response.file.content`.
  // Check the nested file shape FIRST so it wins over any same-named key
  // at the top level.
  if (resp.file !== undefined) {
    const f = resp.file;
    if (typeof f.content === "string" && f.content.length > 0) return f.content;
    if (typeof f.text === "string" && f.text.length > 0) return f.text;
  }
  
  if (typeof resp.content === "string" && resp.content.length > 0) return resp.content;
  if (typeof resp.text === "string" && resp.text.length > 0) return resp.text;
  if (typeof resp.output === "string" && resp.output.length > 0) return resp.output;

  return undefined;
}

function isBinary(content: string): boolean {
  const sampleLen = Math.min(content.length, BINARY_SAMPLE_BYTES);
  let nullCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (content.charCodeAt(i) === 0) nullCount++;
  }
  return nullCount / sampleLen > BINARY_THRESHOLD;
}

/** True when `relPath` sits inside any workspace's component dir. */
function fileInComponentDir(
  config: NormalizedComponentsConfig,
  relPath: string,
): boolean {
  const p = relPath.replace(/\\/g, "/");
  for (const ws of config.workspaces) {
    for (const dir of ws.componentDirs) {
      if (p === dir || p.startsWith(`${dir}/`)) return true;
    }
  }
  return false;
}

/** Render the deduped component slice (D17): name · category · purpose · [S]. */
function renderComponentSlice(components: ComponentLedgerEntry[]): string {
  const lines: string[] = [
    "## Cairn — components in scope (USE > EXTEND > CREATE)",
  ];
  for (const c of components) {
    const flag = c.singleton ? " [S]" : "";
    const purpose = c.purpose.length > 0 ? ` · ${c.purpose}` : "";
    lines.push(`- ${c.name} · ${c.category}${purpose}${flag}`);
  }
  lines.push("`[S]` = singleton: extend in place, never fork or rebuild.");
  return lines.join("\n");
}
