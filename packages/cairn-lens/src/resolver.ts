/**
 * Lens resolver — thin wrapper over `cairn-core` ledger readers.
 *
 * The Lens reuses the same on-disk sources as the PostToolUse hooks: the
 * invariants ledger, the decisions ledger, the scope-index, and the component
 * registry. This module exposes a single `LensResolver` that accepts a
 * workspace folder root and answers citation queries directly from disk — no
 * MCP, no subprocess.
 *
 * Spec: docs/LENS_SPEC.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  componentsIndexPath,
  decisionsDir,
  decisionsLedgerPath,
  getComponent,
  getInvariantsLedger,
  getScopeIndexEntry,
  invariantsDir,
  invariantsLedgerPath,
  isGhost,
  readAnchorMap,
  readScopeIndex,
  readSotBindings,
  readTopicIndex,
  scopeIndexPath,
  sotRenderedCacheDir,
  type AnchorMapEntry,
  type ComponentLedgerEntry,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "@isaacriehm/cairn-state";
import { lensLog } from "./debug-log.js";

interface DecisionResolution {
  id: string;
  title: string;
  status: "accepted" | "unknown";
}

/**
 * Body-rendering result used by the Lens hover provider — extends
 * `DecisionResolution` with the SoT-aware payload introduced in
 * v0.5.0 (plan §10). For `sot_kind: ledger` entries the body comes
 * straight from `.cairn/ground/decisions/<id>.md`. For `sot_kind:
 * path` entries the body comes from the live source via the
 * anchor-map; on miss the resolver falls back to the on-disk
 * snapshot under `.cairn/cache/sot-rendered/<id>.md`.
 */
interface DecisionBody {
  id: string;
  title: string;
  status: "accepted" | "unknown";
  body: string;
  /** "ledger" | "path" — when "unknown", body is empty. */
  sot_kind: "ledger" | "path" | "unknown";
  /** Path (file#anchor for path-kind, "ledger" for ledger-kind, "" when unknown). */
  sot_path: string;
  /** True when body was loaded from the offline snapshot, not the live source. */
  fromCache: boolean;
}

/**
 * Body-rendering result for invariants. Same SoT pivot as
 * `DecisionBody`.
 */
interface InvariantBody {
  id: string;
  title: string;
  status: "active" | "superseded" | "unknown";
  supersededBy: string | null;
  body: string;
  sot_kind: "ledger" | "path" | "unknown";
  sot_path: string;
  fromCache: boolean;
}

interface InvariantResolution {
  id: string;
  title: string;
  status: "active" | "superseded" | "unknown";
  supersededBy: string | null;
  sourceDecision: string | null;
}

/**
 * Resolution of a `@cairn <Name>` registry header. `entry` is the
 * derived ledger projection; `exportName` is the detected export so the
 * hover can flag drift (header name ≠ exported name).
 */
interface ComponentResolution {
  found: boolean;
  entry: ComponentLedgerEntry | null;
  exportName: string | null;
}

interface ScopeRulesForFile {
  decisions: { id: string; title: string }[];
  invariants: { id: string; title: string }[];
  unscoped: boolean;
}

/**
 * A source block bound to a DEC/INV via the external anchor-map (§3.7) — the
 * ghost analog of an in-source `§` cite. `startLine`/`endLine` are 1-indexed
 * source lines (as stored in the anchor-map).
 */
export interface GovernedBlock {
  id: string;
  kind: "decision" | "invariant";
  startLine: number;
  endLine: number;
  title: string;
  status: string;
}

/**
 * Ghost resolution (§3.7): when no in-tree `.cairn/` exists, the repo may be
 * ghost-adopted with state out-of-repo. Resolve the git toplevel and return it
 * only when the global registry has it ghost-registered (keyed on root-commit
 * inside `isGhost`). Returns null for a non-adopted repo. vscode-free so the
 * smoke harness can exercise it directly.
 */
function resolveGhostRepoRoot(cwd: string): string | null {
  let top: string;
  try {
    top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (top.length === 0) return null;
  try {
    return isGhost(top) ? top : null;
  } catch {
    return null;
  }
}

export class LensResolver {
  constructor(public readonly repoRoot: string) {}

  /**
   * Resolve the cairn repo root for a file. **Committed:** walk up looking for
   * an in-tree `.cairn/` and return the dir containing it (byte-identical to the
   * original behavior). **Ghost (§3.7):** there is no in-tree `.cairn/` — the
   * state lives out-of-repo — so fall back to the git toplevel and accept it
   * only when the global registry has it ghost-registered. Without this the lens
   * finds nothing in a ghost repo and the whole extension stays inert.
   */
  static resolveRepoRoot(cwd: string): string | null {
    let dir = resolve(cwd);
    for (let i = 0; i < 12; i++) {
      const probe = join(dir, ".cairn");
      if (existsSync(probe)) {
        try {
          if (statSync(probe).isDirectory()) return dir;
        } catch {
          // fall through
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return resolveGhostRepoRoot(cwd);
  }

  /**
   * Resolve a §DEC-<hash> citation to a structured result.
   *
   * Reads directly from the decisions .md frontmatter via buildDecisionsLedger
   * (which tolerates a missing or empty decisions dir). Returns status "unknown"
   * when no matching accepted decision is found.
   */
  /**
   * Resolve a §DEC-<hash> citation to its body — plan §10. Reads
   * `sot-bindings.yaml` to find the SoT path; routes to the ledger
   * entity file or the live-source anchor accordingly. Caches the
   * rendered body to `.cairn/cache/sot-rendered/<id>.md` so a later
   * call after the source disappears (rename, branch swap, deleted
   * file) can fall back gracefully.
   */
  resolveDecisionBody(id: string): DecisionBody {
    const base = this.resolveDecision(id);
    const out: DecisionBody = {
      id: base.id,
      title: base.title,
      status: base.status,
      body: "",
      sot_kind: "unknown",
      sot_path: "",
      fromCache: false,
    };

    let bindings;
    try {
      bindings = readSotBindings(this.repoRoot);
    } catch (err) {
      lensLog(
        `resolveDecisionBody(${id}) — sot-bindings read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Fall through to ledger-only.
      bindings = null;
    }

    const sotPath: string | null =
      bindings === null ? null : (bindings.forward[id] ?? null);

    // Default: ledger-kind. Ledger entity file always lives under
    // `.cairn/ground/decisions/<id>.md` regardless of bindings state.
    if (sotPath === null || sotPath === "ledger") {
      out.sot_kind = sotPath === null ? "unknown" : "ledger";
      out.sot_path = sotPath ?? "";
      const body = readEntityBodyFromDisk(decisionsDir(this.repoRoot), id);
      if (body !== null) {
        out.body = body;
        // Snapshot the ledger body too — keeps offline rendering
        // symmetric across kinds.
        writeRenderedSnapshot(this.repoRoot, id, body);
      } else {
        const cached = readRenderedSnapshot(this.repoRoot, id);
        if (cached !== null) {
          out.body = cached;
          out.fromCache = true;
        }
      }
      return out;
    }

    // Path-kind: read the live file at the recorded anchor.
    out.sot_kind = "path";
    out.sot_path = sotPath;
    const liveBody = readBodyFromAnchorMap(this.repoRoot, sotPath);
    if (liveBody !== null) {
      out.body = liveBody;
      writeRenderedSnapshot(this.repoRoot, id, liveBody);
      return out;
    }
    const snapshot = readRenderedSnapshot(this.repoRoot, id);
    if (snapshot !== null) {
      out.body = snapshot;
      out.fromCache = true;
    }
    return out;
  }

  /**
   * Same SoT pivot as `resolveDecisionBody` but for invariants.
   * Invariant ledger entities live under `.cairn/ground/invariants/`.
   */
  resolveInvariantBody(id: string): InvariantBody {
    const base = this.resolveInvariant(id);
    const out: InvariantBody = {
      id: base.id,
      title: base.title,
      status: base.status,
      supersededBy: base.supersededBy,
      body: "",
      sot_kind: "unknown",
      sot_path: "",
      fromCache: false,
    };

    let bindings;
    try {
      bindings = readSotBindings(this.repoRoot);
    } catch {
      bindings = null;
    }
    const sotPath: string | null =
      bindings === null ? null : (bindings.forward[id] ?? null);

    if (sotPath === null || sotPath === "ledger") {
      out.sot_kind = sotPath === null ? "unknown" : "ledger";
      out.sot_path = sotPath ?? "";
      const body = readEntityBodyFromDisk(invariantsDir(this.repoRoot), id);
      if (body !== null) {
        out.body = body;
        writeRenderedSnapshot(this.repoRoot, id, body);
      } else {
        const cached = readRenderedSnapshot(this.repoRoot, id);
        if (cached !== null) {
          out.body = cached;
          out.fromCache = true;
        }
      }
      return out;
    }

    out.sot_kind = "path";
    out.sot_path = sotPath;
    const liveBody = readBodyFromAnchorMap(this.repoRoot, sotPath);
    if (liveBody !== null) {
      out.body = liveBody;
      writeRenderedSnapshot(this.repoRoot, id, liveBody);
      return out;
    }
    const snapshot = readRenderedSnapshot(this.repoRoot, id);
    if (snapshot !== null) {
      out.body = snapshot;
      out.fromCache = true;
    }
    return out;
  }

  resolveDecision(id: string): DecisionResolution {
    try {
      const ledger = buildDecisionsLedger({ repoRoot: this.repoRoot });
      lensLog(
        `resolveDecision(${id}): scanned ${ledger.length} accepted decisions`,
      );
      for (const d of ledger) {
        if (d.id === id) {
          lensLog(`resolveDecision(${id}) → accepted: ${d.title}`);
          return { id, title: d.title, status: "accepted" };
        }
      }
    } catch (err) {
      lensLog(
        `resolveDecision(${id}) FAILED: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    lensLog(`resolveDecision(${id}) → unknown (not in ledger)`);
    return { id, title: id, status: "unknown" };
  }

  /**
   * Resolve a §INV-<hash> citation to a structured result.
   *
   * The cached `getInvariantsLedger` reader from cairn-core only carries
   * active entries; superseded ids appear only when the invariants-ledger
   * file lists them. For Lens purposes that means: if `getInvariantsLedger`
   * has the id with `superseded_by` set → superseded; absent → unknown.
   */
  resolveInvariant(id: string): InvariantResolution {
    const snapshot = getInvariantsLedger(this.repoRoot);
    if (snapshot !== null) {
      const cached = snapshot.invariantsByid.get(id);
      if (cached !== undefined) {
        const supersededBy = cached.superseded_by ?? null;
        lensLog(
          `resolveInvariant(${id}) → cached hit (status=${
            supersededBy !== null ? "superseded" : "active"
          })`,
        );
        return {
          id,
          title: cached.title,
          status: supersededBy !== null ? "superseded" : "active",
          supersededBy,
          sourceDecision: null,
        };
      }
      lensLog(
        `resolveInvariant(${id}) — cached snapshot has ${snapshot.invariantsByid.size} entries but id miss; falling through`,
      );
    } else {
      lensLog(
        `resolveInvariant(${id}) — cached snapshot null; falling through to direct read`,
      );
    }
    // Fall back to the directly-built ledger which scans frontmatter — it has
    // the source_decision field populated for active entries.
    try {
      const direct = buildInvariantsLedger({ repoRoot: this.repoRoot });
      lensLog(
        `resolveInvariant(${id}): direct scan returned ${direct.length} entries`,
      );
      for (const entry of direct) {
        if (entry.id === id) {
          lensLog(`resolveInvariant(${id}) → active: ${entry.title}`);
          return {
            id,
            title: entry.title,
            status: "active",
            supersededBy: null,
            sourceDecision: entry.source_decision ?? null,
          };
        }
      }
    } catch (err) {
      lensLog(
        `resolveInvariant(${id}) FAILED: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    lensLog(`resolveInvariant(${id}) → unknown (not in ledger)`);
    return {
      id,
      title: id,
      status: "unknown",
      supersededBy: null,
      sourceDecision: null,
    };
  }

  /**
   * Resolve a `@cairn <Name>` registry header to its component ledger
   * entry. Collects the registry from the live `@cairn` headers (the
   * committed source of truth), so it works even though the derived
   * index under `.cairn/ground/components/` is gitignored / may be
   * stale. Returns `found: false` when no component carries that name.
   */
  resolveComponent(name: string): ComponentResolution {
    try {
      const r = getComponent(this.repoRoot, name);
      if (r === null) return { found: false, entry: null, exportName: null };
      return { found: true, entry: r.entry, exportName: r.record.exportName };
    } catch (err) {
      lensLog(
        `resolveComponent(${name}) FAILED: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { found: false, entry: null, exportName: null };
    }
  }

  /** Absolute on-disk path of the component index (INDEX.md / manifest). */
  componentsIndexFilePath(): string {
    return componentsIndexPath(this.repoRoot);
  }

  /** O(1) scope-index lookup — null when no entry / unscoped / empty. */
  resolveScope(repoRelativePath: string): ScopeIndexEntry | null {
    return getScopeIndexEntry(this.repoRoot, repoRelativePath);
  }

  /**
   * Hydrated rules-in-scope view: like `resolveScope` but with each id
   * resolved to its title from the ledgers. Returned `unscoped: true` when
   * the index entry exists with that flag (caller may render a different
   * decoration in that case).
   */
  resolveScopeWithTitles(repoRelativePath: string): ScopeRulesForFile | null {
    const index = readScopeIndex(this.repoRoot);
    if (index === null) return null;
    const entry = index.files[repoRelativePath];
    if (entry === undefined) return null;
    if (entry.unscoped === true) {
      return { decisions: [], invariants: [], unscoped: true };
    }

    const decisionTitles = new Map<string, string>();
    try {
      for (const d of buildDecisionsLedger({ repoRoot: this.repoRoot })) {
        decisionTitles.set(d.id, d.title);
      }
    } catch {
      // ignore — leave map empty
    }

    const invariantTitles = new Map<string, string>();
    const snap = getInvariantsLedger(this.repoRoot);
    if (snap !== null) {
      for (const [id, info] of snap.invariantsByid.entries()) {
        invariantTitles.set(id, info.title);
      }
    }

    const decisions = entry.decisions.map((id) => ({
      id,
      title: decisionTitles.get(id) ?? id,
    }));
    const invariants = entry.invariants.map((id) => ({
      id,
      title: invariantTitles.get(id) ?? id,
    }));
    return { decisions, invariants, unscoped: false };
  }

  /**
   * Governed blocks for a file, sourced from the external anchor-map +
   * topic-index instead of in-source `§` tokens (ghost-mode design).
   *
   * In committed mode the `§DEC`/`§INV` cite in the source is the decoration
   * trigger; ghost writes no cite, so the binding lives out-of-repo: the
   * anchor-map records each governed block's `{ file, line_range }` (keyed by
   * topic slug) and the topic-index maps that slug → the DEC/INV id. Joining
   * them yields the same `(id, range, title, status)` a token scan would, with
   * no literal marker in the source. vscode-free so the smoke can exercise it.
   * Returns [] off the happy path (missing stores, no anchors for the file).
   */
  ghostGovernedBlocks(relPath: string): GovernedBlock[] {
    const out: GovernedBlock[] = [];
    let anchors: ReturnType<typeof readAnchorMap>;
    let topics: ReturnType<typeof readTopicIndex>;
    try {
      anchors = readAnchorMap(this.repoRoot);
      topics = readTopicIndex(this.repoRoot);
    } catch {
      return out;
    }
    for (const [slug, entry] of Object.entries(anchors.anchors)) {
      if (entry.file !== relPath) continue;
      const range = entry.line_range;
      if (range === undefined) continue;
      const id = topics.topics[slug]?.dec_id;
      if (id === undefined || id.length === 0) continue;
      const isInv = id.startsWith("INV-");
      const res = isInv ? this.resolveInvariant(id) : this.resolveDecision(id);
      out.push({
        id,
        kind: isInv ? "invariant" : "decision",
        startLine: range[0],
        endLine: range[1],
        title: res.title,
        status: res.status,
      });
    }
    out.sort((a, b) => a.startLine - b.startLine);
    return out;
  }

  /**
   * Mode-agnostic governed-block lookup for an absolute file path — the single
   * selection point for the ghost fork the lens providers share. Ghost: the
   * anchor-map blocks for the file. Committed: `[]` (the `§`-token scan in the
   * provider is the trigger). Each provider calls this instead of repeating
   * `isGhost(...)` + `relative(...)` + `ghostGovernedBlocks(...)`, so the mode
   * decision lives here, not scattered across three providers (§3.0).
   */
  governedBlocksForFile(fsPath: string): GovernedBlock[] {
    if (!isGhost(this.repoRoot)) return [];
    return this.ghostGovernedBlocks(relative(this.repoRoot, fsPath));
  }

  /** Returns the absolute on-disk path of the scope-index file. */
  scopeIndexFilePath(): string {
    return scopeIndexPath(this.repoRoot);
  }

  /** Returns the absolute on-disk path of the invariants ledger. */
  invariantsLedgerFilePath(): string {
    // Through cairn-state so it resolves out-of-repo in ghost (§3.7).
    return invariantsLedgerPath(this.repoRoot);
  }

  /** Returns the absolute on-disk path of the decisions ledger. */
  decisionsLedgerFilePath(): string {
    return decisionsLedgerPath(this.repoRoot);
  }

  /**
   * Convenience wrapper: returns the parsed scope-index (or null).
   * Uncached read — Lens callers that need the full index typically iterate
   * over its files for the DEC explorer and don't benefit from the
   * mtime-keyed cache the cairn layer relies on.
   */
  loadScopeIndex(): ScopeIndex | null {
    return readScopeIndex(this.repoRoot);
  }
}

/* -------------------------------------------------------------------------- */
/* SoT body helpers (plan §10)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Strip the leading `---\n…\n---\n?` frontmatter block from a DEC/INV
 * ledger entity file and return the trimmed body. Returns null when
 * the file is missing or unreadable.
 */
function readEntityBodyFromDisk(dir: string, id: string): string | null {
  const abs = join(dir, `${id}.md`);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return (m === null ? raw : raw.slice(m[0].length)).trim();
}

/**
 * Walk anchor-map.yaml for a path-kind sot_path (e.g. `docs/auth.md#tokens`)
 * and return the live source body at the recorded anchor. Returns
 * null when the file is missing, the slug is absent, or the line
 * range is malformed.
 *
 * Anchor-map keys are slugs that the init pipeline derived from the
 * heading or paragraph content. The reverse-lookup walks every entry
 * checking `entry.file === <pathPart>` until we find one whose
 * `current_anchor` matches the fragment. If no fragment is provided
 * the first entry on the file wins.
 */
function readBodyFromAnchorMap(repoRoot: string, sotPath: string): string | null {
  let map;
  try {
    map = readAnchorMap(repoRoot);
  } catch {
    return null;
  }
  const [pathPart, fragment] = splitSotPath(sotPath);
  if (pathPart === "") return null;

  let match: AnchorMapEntry | null = null;
  for (const slug of Object.keys(map.anchors)) {
    const entry = map.anchors[slug];
    if (entry === undefined) continue;
    if (entry.file !== pathPart) continue;
    if (fragment !== null && entry.current_anchor !== fragment) continue;
    match = entry;
    break;
  }
  if (match === null) return null;

  const abs = join(repoRoot, match.file);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (match.line_range === undefined) return raw.trim();
  const [startLine, endLine] = match.line_range;
  const lines = raw.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  if (end <= start) return null;
  return lines.slice(start, end).join("\n").trim();
}

function splitSotPath(sotPath: string): [string, string | null] {
  const idx = sotPath.indexOf("#");
  if (idx === -1) return [sotPath, null];
  return [sotPath.slice(0, idx), sotPath.slice(idx + 1)];
}

/**
 * Snapshot a successfully-rendered body to
 * `.cairn/cache/sot-rendered/<id>.md`. Best-effort — write failures
 * never block the live render.
 */
function writeRenderedSnapshot(repoRoot: string, id: string, body: string): void {
  if (body.length === 0) return;
  const dir = sotRenderedCacheDir(repoRoot);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.md`), body, "utf8");
  } catch {
    /* best-effort — Lens never blocks on cache writes */
  }
}

function readRenderedSnapshot(repoRoot: string, id: string): string | null {
  const path = join(sotRenderedCacheDir(repoRoot), `${id}.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
