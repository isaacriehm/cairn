/**
 * Lens resolver — thin wrapper over `cairn-core` ledger readers.
 *
 * The Lens reuses the same on-disk sources as the PostToolUse hooks: the
 * invariants ledger, the decisions ledger, the scope-index, and the per-task
 * directories under `.cairn/tasks/{active,done}/`. This module exposes a
 * single `LensResolver` that accepts a workspace folder root and answers
 * citation queries directly from disk — no MCP, no subprocess.
 *
 * Spec: docs/LENS_SPEC.md.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildDecisionsLedger,
  buildInvariantsLedger,
  getInvariantsLedger,
  getScopeIndexEntry,
  lookupTask,
  readScopeIndex,
  scopeIndexPath,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "@isaacriehm/cairn-core";
import { lensLog } from "./debug-log.js";

interface DecisionResolution {
  id: string;
  title: string;
  status: "accepted" | "unknown";
}

interface InvariantResolution {
  id: string;
  title: string;
  status: "active" | "superseded" | "unknown";
  supersededBy: string | null;
  sourceDecision: string | null;
}

interface TaskResolution {
  id: string;
  found: "active" | "done" | "not_found";
  title: string | null;
}

interface ScopeRulesForFile {
  decisions: { id: string; title: string }[];
  invariants: { id: string; title: string }[];
  unscoped: boolean;
}

export class LensResolver {
  constructor(public readonly repoRoot: string) {}

  /**
   * Walks up from `cwd` looking for `.cairn/`. Returns the dir containing
   * it, or null when the file is not under a cairn-adopted repo.
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
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  /**
   * Resolve a §DEC-NNNN citation to a structured result.
   *
   * Reads directly from the decisions .md frontmatter via buildDecisionsLedger
   * (which tolerates a missing or empty decisions dir). Returns status "unknown"
   * when no matching accepted decision is found.
   */
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
   * Resolve a §INV-NNNN citation to a structured result.
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

  /** Resolve a TODO(TSK-<id>) citation against the active+done task dirs. */
  resolveTask(id: string): TaskResolution {
    const result = lookupTask(this.repoRoot, id);
    return {
      id,
      found: result.found,
      title: result.title ?? null,
    };
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

  /** Returns the absolute on-disk path of the scope-index file. */
  scopeIndexFilePath(): string {
    return scopeIndexPath(this.repoRoot);
  }

  /** Returns the absolute on-disk path of the invariants ledger. */
  invariantsLedgerFilePath(): string {
    return join(
      this.repoRoot,
      ".cairn",
      "ground",
      "invariants",
      "invariants.ledger.yaml",
    );
  }

  /** Returns the absolute on-disk path of the decisions ledger. */
  decisionsLedgerFilePath(): string {
    return join(
      this.repoRoot,
      ".cairn",
      "ground",
      "decisions",
      "decisions.ledger.yaml",
    );
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
