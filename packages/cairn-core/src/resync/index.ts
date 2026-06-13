/**
 * `cairn resync` — operator-initiated incremental re-discovery (Stage 3).
 *
 * Stage 1's config-drift sensor SURFACES the gap between declared config and
 * the grown tree; resync is the operator-initiated verb that RESOLVES it. This
 * v1 closes the deterministic half of the loop: it re-runs the config-drift
 * detector and turns each finding into a concrete `config.yaml` edit —
 *
 *   - `config_uncovered_dir`     → add the dir to the owning workspace's
 *                                  `componentDirs`
 *   - `config_uncovered_ext`     → add the file type to that workspace's
 *                                  `extensions`
 *   - `config_gitignore_drift`   → add the ignored path to top-level
 *                                  `off_limits`
 *   - `config_orphan_path`       → drop the dead `componentDir`
 *
 * Safety (Q23): `--dry-run` (the default) mutates nothing — it returns the
 * proposed edits for the operator to review. Apply archives the pre-resync
 * `config.yaml` to `.cairn/ground/.archive/` first, edits via the comment-
 * preserving yaml Document API, and is idempotent on a clean delta (re-run
 * after apply proposes nothing). The edit is a `review`-class mutation of
 * committed config the operator commits; derived state stays gitignored +
 * per-clone, so there is no new multi-dev conflict surface (Q22).
 *
 * Deferred to the LLM half (Q3/Q16, opt-in, quota-gated): hash-rematch of moved
 * entities, Haiku re-cluster of topic-index/canonical-map over genuinely-new
 * prose, and re-curation of new areas into DEC/INV drafts. `domain_summary`
 * (Q15) is an init-time seed for the brand bodies, not live agent context, so
 * resync does not refresh it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  configPath,
  decisionsDir,
  invariantsDir,
  knownExtensions,
  loadComponentsConfig,
  parseFrontmatterRecord,
  type ComponentWorkspace,
} from "@isaacriehm/cairn-state";
import { runConfigDrift } from "../gc/config-drift.js";
import { walkSourceTree } from "../gc/walk-source.js";
import { loadConfigDoc, writeConfigDoc } from "../migrate/config-io.js";
import { archiveFile } from "./archive.js";

export {
  runResyncRecluster,
  type ResyncReclusterOptions,
  type ResyncReclusterResult,
} from "./recluster.js";
export type { ProseBlock, SemanticJudge, SemanticVerdict } from "../init/topic-index/resolve.js";

export type ResyncProposalKind =
  | "add_component_dir"
  | "add_extension"
  | "add_off_limits"
  | "drop_component_dir"
  | "repoint_source";

export interface ResyncProposal {
  kind: ResyncProposalKind;
  /** Target workspace ("" = single-app). Absent for off_limits / repoint. */
  workspace?: string;
  /** The dir / extension / glob added or dropped, or the new source_file. */
  value: string;
  /** Originating config-drift finding kind (or "stale_source" for rematch). */
  from: string;
  /** Human-readable one-liner. */
  detail: string;
  /** repoint_source — the entity being re-pointed. */
  entityId?: string;
  /** repoint_source — repo-relative path of the entity `.md`. */
  entityPath?: string;
}

export interface ResyncResult {
  dryRun: boolean;
  proposals: ResyncProposal[];
  applied: boolean;
  /** Repo-relative path of the pre-resync config backup, or null. */
  archivedConfig: string | null;
  /** Repo-relative paths of pre-resync entity backups (source rematch). */
  archivedEntities: string[];
  /** Findings that produced no actionable proposal, with why. */
  skipped: { finding: string; path: string; reason: string }[];
}

export interface RunResyncOptions {
  repoRoot: string;
  /** Preview only — mutate nothing. Default true (safe). */
  dryRun?: boolean;
  /** Limit to findings whose path is at/under this repo-relative dir. */
  area?: string;
  /** Injected ISO for the archive filename (determinism in tests). */
  nowIso?: string;
}

function trimSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

function commonDirPrefix(dirs: readonly string[]): string {
  if (dirs.length === 0) return "";
  const split = dirs.map((d) => trimSlash(d).split("/"));
  const first = split[0]!;
  let len = first.length;
  for (const segs of split) {
    let i = 0;
    while (i < len && i < segs.length && segs[i] === first[i]) i++;
    len = i;
  }
  return first.slice(0, len).join("/");
}

function isUnder(rel: string, dir: string): boolean {
  const n = trimSlash(dir);
  return n.length > 0 && (rel === n || rel.startsWith(`${n}/`));
}

/** Workspace whose root (common prefix of its componentDirs) contains `dir`. */
function attributeDirToWorkspace(dir: string, workspaces: readonly ComponentWorkspace[]): string {
  let best: string | null = null;
  let bestLen = -1;
  for (const ws of workspaces) {
    const root = commonDirPrefix(ws.componentDirs);
    if (isUnder(dir, root) && root.length > bestLen) {
      best = ws.name;
      bestLen = root.length;
    }
  }
  return best ?? workspaces[0]?.name ?? "";
}

/** Workspace whose componentDir is the longest prefix of `file`. */
function owningWorkspace(file: string, workspaces: readonly ComponentWorkspace[]): string {
  let best: string | null = null;
  let bestLen = -1;
  for (const ws of workspaces) {
    for (const d of ws.componentDirs) {
      const n = trimSlash(d);
      if (isUnder(file, n) && n.length > bestLen) {
        best = ws.name;
        bestLen = n.length;
      }
    }
  }
  return best ?? workspaces[0]?.name ?? "";
}

/** Workspace that declares `dir` verbatim as a componentDir, or null. */
function workspaceDeclaring(dir: string, workspaces: readonly ComponentWorkspace[]): string | null {
  const target = trimSlash(dir);
  for (const ws of workspaces) {
    if (ws.componentDirs.map(trimSlash).includes(target)) return ws.name;
  }
  return null;
}

function dedupKey(p: ResyncProposal): string {
  return `${p.kind} ${p.workspace ?? ""} ${p.entityPath ?? ""} ${p.value}`;
}

const INV_CITE_RE = /§INV-([0-9a-f]{7,})\b/g;
const DEC_CITE_RE = /§DEC-([0-9a-f]{7,})\b/g;

function citeScanExtensions(): Set<string> {
  return new Set<string>([...knownExtensions(), ".html", ".css", ".scss", ".md"]);
}

function fileExt(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i === -1 ? "" : rel.slice(i).toLowerCase();
}

/** Map every cited `§DEC-`/`§INV-` id → the set of files that cite it. */
function buildCiteFileMap(repoRoot: string): Map<string, Set<string>> {
  const exts = citeScanExtensions();
  const map = new Map<string, Set<string>>();
  const add = (id: string, file: string): void => {
    const s = map.get(id) ?? new Set<string>();
    s.add(file);
    map.set(id, s);
  };
  for (const rel of walkSourceTree(repoRoot)) {
    if (!exts.has(fileExt(rel))) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(DEC_CITE_RE)) add(`DEC-${m[1]}`, rel);
    for (const m of content.matchAll(INV_CITE_RE)) add(`INV-${m[1]}`, rel);
  }
  return map;
}

/**
 * Hash-rematch's deterministic, committed-mode case (Q3 "free" half): a
 * ledger-backed DEC/INV whose recorded `source_file` no longer exists, but
 * whose `§cite` now lives in exactly one OTHER file — the file was renamed and
 * the cite moved with its content, so the cite is the authoritative new home.
 * Re-point `source_file` there (keeps `cairn_in_scope`'s source_file match —
 * the Stage 0 fix — accurate after a rename). Ambiguous (0 or >1 citing files)
 * is left to the entity-orphan pass. Ghost (no cites) yields nothing here.
 */
function deriveSourceRematch(repoRoot: string): ResyncProposal[] {
  const citeMap = buildCiteFileMap(repoRoot);
  const out: ResyncProposal[] = [];
  const groups = [
    { dir: decisionsDir(repoRoot), rel: ".cairn/ground/decisions" },
    { dir: invariantsDir(repoRoot), rel: ".cairn/ground/invariants" },
  ];
  for (const g of groups) {
    let names: string[];
    try {
      names = readdirSync(g.dir, { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md") || name.startsWith("_")) continue;
      const abs = join(g.dir, name);
      let fm: Record<string, unknown>;
      try {
        fm = parseFrontmatterRecord(readFileSync(abs, "utf8")).fm;
      } catch {
        continue;
      }
      const status = typeof fm["status"] === "string" ? fm["status"] : "";
      if (status === "archived" || status === "superseded") continue;
      const sotKind = typeof fm["sot_kind"] === "string" ? fm["sot_kind"] : "ledger";
      if (sotKind !== "ledger") continue;
      const src = typeof fm["source_file"] === "string" ? fm["source_file"] : "";
      const id = typeof fm["id"] === "string" ? fm["id"] : "";
      if (src.length === 0 || id.length === 0) continue;
      if (existsSync(join(repoRoot, src))) continue; // source still present → fine
      const files = [...(citeMap.get(id) ?? [])];
      if (files.length !== 1) continue; // 0 = orphan (entity-orphan's job); >1 = ambiguous
      const newSrc = files[0]!;
      if (newSrc === src) continue;
      out.push({
        kind: "repoint_source",
        value: newSrc,
        from: "stale_source",
        entityId: id,
        entityPath: `${g.rel}/${name}`,
        detail: `re-point ${id} source_file \`${src}\` → \`${newSrc}\` (file moved; cite followed)`,
      });
    }
  }
  return out;
}

/** Map current config-drift findings → deterministic config-edit proposals. */
function deriveProposals(
  repoRoot: string,
  area: string | undefined,
): { proposals: ResyncProposal[]; skipped: ResyncResult["skipped"] } {
  const { workspaces } = loadComponentsConfig(repoRoot);
  const findings = runConfigDrift({ repoRoot }).findings.filter(
    (f) => area === undefined || f.path === area || f.path.startsWith(`${trimSlash(area)}/`),
  );

  const proposals: ResyncProposal[] = [];
  const skipped: ResyncResult["skipped"] = [];
  const seen = new Set<string>();
  const push = (p: ResyncProposal): void => {
    const k = dedupKey(p);
    if (seen.has(k)) return;
    seen.add(k);
    proposals.push(p);
  };

  for (const f of findings) {
    switch (f.kind) {
      case "config_uncovered_dir": {
        const ws = attributeDirToWorkspace(f.path, workspaces);
        push({
          kind: "add_component_dir",
          workspace: ws,
          value: f.path,
          from: f.kind,
          detail: `add componentDir \`${f.path}\`${ws ? ` to workspace ${ws}` : ""}`,
        });
        break;
      }
      case "config_uncovered_ext": {
        const ws = owningWorkspace(f.path, workspaces);
        const ext = extname(f.path);
        if (ext.length === 0) {
          skipped.push({ finding: f.kind, path: f.path, reason: "no file extension" });
          break;
        }
        push({
          kind: "add_extension",
          workspace: ws,
          value: ext,
          from: f.kind,
          detail: `add extension \`${ext}\`${ws ? ` to workspace ${ws}` : ""}`,
        });
        break;
      }
      case "config_gitignore_drift": {
        push({
          kind: "add_off_limits",
          value: f.path,
          from: f.kind,
          detail: `add \`${f.path}\` to off_limits`,
        });
        break;
      }
      case "config_orphan_path": {
        const ws = workspaceDeclaring(f.path, workspaces);
        if (ws === null) {
          skipped.push({ finding: f.kind, path: f.path, reason: "no workspace declares this dir" });
          break;
        }
        push({
          kind: "drop_component_dir",
          workspace: ws,
          value: f.path,
          from: f.kind,
          detail: `drop dead componentDir \`${f.path}\`${ws ? ` from workspace ${ws}` : ""}`,
        });
        break;
      }
      default:
        // Non-config-drift findings (other GC passes) aren't resync's job.
        break;
    }
  }

  // Source rematch (Q3 free half) — re-point stale source_file pointers.
  for (const p of deriveSourceRematch(repoRoot)) {
    if (area !== undefined && p.value !== area && !p.value.startsWith(`${trimSlash(area)}/`)) {
      continue;
    }
    push(p);
  }

  proposals.sort((a, b) => dedupKey(a).localeCompare(dedupKey(b)));
  return { proposals, skipped };
}

/** Config Document path to a workspace's array field (flat single-app vs map). */
function fieldPath(workspace: string | undefined, field: string): (string | number)[] {
  return workspace !== undefined && workspace.length > 0
    ? ["components", "workspaces", workspace, field]
    : ["components", field];
}

function asArray(node: unknown): string[] {
  if (node === null || node === undefined) return [];
  const json = (node as { toJSON?: () => unknown }).toJSON?.() ?? node;
  return Array.isArray(json) ? (json as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

/** Resolve a `.cairn/ground/{decisions,invariants}/X.md` rel path to abs (mode-aware). */
function entityAbs(repoRoot: string, entityPath: string): string {
  const base = entityPath.split("/").pop()!;
  return entityPath.includes("/decisions/")
    ? join(decisionsDir(repoRoot), base)
    : join(invariantsDir(repoRoot), base);
}

/** Rewrite the (frontmatter) `source_file:` line in place. */
function repointSource(abs: string, newSrc: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  if (!/^source_file:\s*.*$/m.test(raw)) return false;
  const next = raw.replace(/^source_file:\s*.*$/m, `source_file: ${newSrc}`);
  if (next === raw) return false;
  try {
    writeFileSync(abs, next, "utf8");
  } catch {
    return false;
  }
  return true;
}

export function runResync(opts: RunResyncOptions): ResyncResult {
  const dryRun = opts.dryRun !== false; // default true (safe)
  const { proposals, skipped } = deriveProposals(opts.repoRoot, opts.area);

  if (dryRun || proposals.length === 0) {
    return {
      dryRun: true,
      proposals,
      applied: false,
      archivedConfig: null,
      archivedEntities: [],
      skipped,
    };
  }

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const configProposals = proposals.filter((p) => p.kind !== "repoint_source");
  const rematchProposals = proposals.filter((p) => p.kind === "repoint_source");

  // ── Config edits (config.yaml) ──────────────────────────────────────
  let archivedConfig: string | null = null;
  if (configProposals.length > 0) {
    archivedConfig = archiveFile(configPath(opts.repoRoot), opts.repoRoot, "config.yaml", nowIso);
    const doc = loadConfigDoc(opts.repoRoot);
    if (doc !== null) {
      for (const p of configProposals) {
        if (p.kind === "add_off_limits") {
          const path = ["off_limits"];
          const cur = asArray(doc.getIn(path));
          if (!cur.includes(p.value)) doc.setIn(path, [...cur, p.value]);
          continue;
        }
        const field = p.kind === "add_extension" ? "extensions" : "componentDirs";
        const path = fieldPath(p.workspace, field);
        const cur = asArray(doc.getIn(path));
        if (p.kind === "drop_component_dir") {
          const next = cur.filter((d) => trimSlash(d) !== trimSlash(p.value));
          if (next.length !== cur.length) doc.setIn(path, next);
        } else if (!cur.includes(p.value)) {
          doc.setIn(path, [...cur, p.value]);
        }
      }
      writeConfigDoc(opts.repoRoot, doc);
    }
  }

  // ── Source rematch (entity .md frontmatter) ─────────────────────────
  const archivedEntities: string[] = [];
  for (const p of rematchProposals) {
    if (p.entityPath === undefined) continue;
    const abs = entityAbs(opts.repoRoot, p.entityPath);
    const base = p.entityPath.split("/").pop()!;
    const archived = archiveFile(abs, opts.repoRoot, base, nowIso);
    if (repointSource(abs, p.value) && archived !== null) {
      archivedEntities.push(archived);
    }
  }

  return {
    dryRun: false,
    proposals,
    applied: true,
    archivedConfig,
    archivedEntities,
    skipped,
  };
}
