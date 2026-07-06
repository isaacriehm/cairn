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
  resolveHookCwd,
  appendTelemetry,
  normalizePostToolUse,
  pickToolResponseContent,
} from "../runners/payload.js";
import { emitPostToolUseOutput } from "../hook-platform.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { scanCitations, type ScannedCitations } from "./citation-scanner.js";
import { buildLegend } from "./legend-builder.js";
import { filterUnshownIds, hasShownId, markShownIds } from "../../session/index.js";
import { logger } from "../../logger.js";

const MAX_CONTENT_BYTES = 512_000;
const BINARY_SAMPLE_BYTES = 1024;
const BINARY_THRESHOLD = 0.05;

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
    const hookPayload = parseHookPayload(raw);
    const payload = normalizePostToolUse(hookPayload);
    sessionForTrace = payload.session_id ?? null;

    if (payload.tool_name !== "Read") {
      outcome = { skip: "non-read-tool", tool_name: payload.tool_name };
      emitPostToolUseOutput("");
      return;
    }
    const filePath = payload.tool_input?.file_path;
    let content = pickToolResponseContent(payload.tool_response);
    if (content === undefined || content.length === 0) {
      const cwdEarly = resolveHookCwd(hookPayload);
      if (filePath !== undefined) {
        const abs = resolve(cwdEarly, filePath);
        if (existsSync(abs)) {
          try {
            content = readFileSync(abs, "utf8");
          } catch {
            /* fall through */
          }
        }
      }
    }
    if (filePath === undefined || content === undefined || content.length === 0) {
      outcome = {
        skip: "no-content",
        file_path: filePath ?? null,
        content_present: content !== undefined,
        content_chars: content?.length ?? 0,
      };
      emitPostToolUseOutput("");
      return;
    }

    const cwd = resolveHookCwd(hookPayload);
    const repoRoot = resolveRepoRoot(cwd);
    repoRootForTrace = repoRoot;
    if (repoRoot === null) {
      outcome = { skip: "not-adopted", cwd };
      emitPostToolUseOutput("");
      return;
    }

    const relPath = relative(repoRoot, resolve(cwd, filePath));
    if (isBinary(content)) {
      outcome = { skip: "binary", path: relPath };
      emitPostToolUseOutput("");
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

    // The stage-1 working header is the persistent in-scope id index, so
    // the enricher's file-scope box ("Decisions/Invariants in scope")
    // renders at most once per file per session. Without this, every
    // re-read of a scoped file re-injects the box — the over-injection
    // the engine exists to avoid (D13).
    const scopeKey = `scope:${relPath}`;
    const showScope =
      scopeEntry !== null &&
      (sessionId === null || !hasShownId(repoRoot, sessionId, scopeKey));

    const legend = buildLegend(
      freshCitations,
      invariantsLedger,
      decisionsLedger,
      showScope ? scopeEntry : null,
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
      const toMark = [
        ...freshIds,
        ...shownComponentKeys,
        ...(showScope ? [scopeKey] : []),
      ];
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

    emitPostToolUseOutput(combined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = { error: message };
    log.error({ err: message }, "read-enricher hook failed");
    emitPostToolUseOutput("");
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
