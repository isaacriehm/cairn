/**
 * Component-annotate capture-gate surface (context engine, stage 3).
 *
 * Mirrors phase-ready-surface: the Stop hook detects components the
 * session touched that still lack a `@cairn` header, pre-derives their
 * mechanical fields (export symbol, allowed categories), and stashes a
 * fully-specified ask to `.cairn/sessions/<id>/annotate-pending.json`.
 * The next UserPromptSubmit injects it as `additionalContext` — inject-
 * only, no Stop block. The pre-commit component check is the hard
 * backstop; this is the deferred nudge.
 *
 * The agent supplies only judgment (category, purpose, aliases); the
 * server holds the grammar + validation in `cairn_component_annotate`.
 *
 * Spec: docs/CONTEXT_ENGINE.md (stage 3), CAIRN_REBUILD §8 / D5–D9.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  cairnDir,
  extractExportName,
  hasComponentConfig,
  loadComponentsConfig,
  type NormalizedComponentsConfig,
} from "@isaacriehm/cairn-state";
import { runComponentCheck } from "../../components/check.js";
import { hasShownId, readTouched } from "../../session/index.js";

export interface AnnotateAsk {
  /** Repo-relative POSIX path of the component file missing a header. */
  file: string;
  /** Best-effort detected export symbol, or null when undetectable. */
  export_name: string | null;
  /** The owning workspace's allowed `@category` taxonomy. */
  categories: string[];
}

interface PendingFile {
  ts: string;
  session_id: string;
  asks: AnnotateAsk[];
}

function pendingPath(repoRoot: string, sessionId: string): string {
  return cairnDir(repoRoot, "sessions", sessionId, "annotate-pending.json");
}

/** Allowed categories for the workspace owning `rel` (longest-prefix). */
function categoriesForFile(
  config: NormalizedComponentsConfig,
  rel: string,
): string[] {
  let best: string[] | null = null;
  let bestLen = -1;
  for (const ws of config.workspaces) {
    for (const dir of ws.componentDirs) {
      if ((rel === dir || rel.startsWith(`${dir}/`)) && dir.length > bestLen) {
        bestLen = dir.length;
        best = ws.categories;
      }
    }
  }
  return best ?? config.workspaces[0]?.categories ?? [];
}

/**
 * Collect the component-dir files this session touched that still lack a
 * `@cairn` header, skipping any already surfaced (`annotate:<file>` in
 * seen.shownIds — the once-per-component debounce, D5). Pure read; the
 * caller marks shown after stashing. Returns [] for non-component repos.
 */
export function collectAnnotateAsks(
  repoRoot: string,
  sessionId: string,
): AnnotateAsk[] {
  const touched = readTouched(repoRoot, sessionId);
  if (touched.length === 0) return [];

  const config = loadComponentsConfig(repoRoot);
  if (!hasComponentConfig(config)) return [];

  // Narrow the component check to touched files; the full repo is still
  // collected (cross-file duplicate-name resolution) but only touched
  // findings are reported.
  const check = runComponentCheck(repoRoot, { files: touched });
  const missing = check.findings
    .filter(
      (f) => f.path !== undefined && /missing @cairn header/.test(f.message),
    )
    .map((f) => f.path as string);

  const asks: AnnotateAsk[] = [];
  for (const rel of missing) {
    if (hasShownId(repoRoot, sessionId, `annotate:${rel}`)) continue;
    let exportName: string | null = null;
    try {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      exportName = extractExportName(src, rel);
    } catch {
      // best-effort — leave export undetected
    }
    asks.push({
      file: rel,
      export_name: exportName,
      categories: categoriesForFile(config, rel),
    });
  }
  return asks;
}

/** Persist the asks for the next UPS to inject. Latest set wins. */
export function writeAnnotatePending(
  repoRoot: string,
  sessionId: string,
  asks: AnnotateAsk[],
): void {
  if (asks.length === 0) return;
  const path = pendingPath(repoRoot, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: PendingFile = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      asks,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/** Read + delete the pending file (show-once). Null when absent/malformed. */
export function readAndConsumeAnnotatePending(
  repoRoot: string,
  sessionId: string,
): AnnotateAsk[] | null {
  const path = pendingPath(repoRoot, sessionId);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try { unlinkSync(path); } catch { /* ignore */ }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Partial<PendingFile>;
  if (!Array.isArray(p.asks) || p.asks.length === 0) return null;
  return p.asks as AnnotateAsk[];
}

/**
 * Render the fully-specified annotate ask. The agent supplies only
 * judgment; the `cairn_component_annotate` call template carries the
 * mechanical fields the server already derived.
 */
export function renderAnnotateHint(asks: AnnotateAsk[]): string {
  if (asks.length === 0) return "";
  const noun = asks.length === 1 ? "component" : "components";
  const lines: string[] = [`## Cairn — ${asks.length} ${noun} need registering`, ""];
  for (const a of asks) {
    const exp =
      a.export_name !== null ? ` exports \`${a.export_name}\`` : "";
    const catHint =
      a.categories.length > 0
        ? `<one of: ${a.categories.join("|")}>`
        : "<category>";
    const exportArg = a.export_name !== null ? a.export_name : "<ExportName>";
    lines.push(`- \`${a.file}\`${exp} — no \`@cairn\` header.`);
    lines.push(
      `  Call: \`cairn_component_annotate({ file:"${a.file}", export_name:"${exportArg}", ` +
        `category:${catHint}, purpose:"<one line>", aliases:["…","…"] })\``,
    );
  }
  lines.push("");
  lines.push(
    "The pre-commit component check blocks the commit until each is registered. " +
      "Surface at a natural stopping point; you supply category/purpose/aliases, the server writes + validates the header.",
  );
  return lines.join("\n");
}
