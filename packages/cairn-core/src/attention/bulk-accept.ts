/**
 * Bulk-accept obvious DEC drafts + stamp confidence on invariants.
 *
 * Mirrors the per-draft accept flow in `mcp/tools/resolve-attention.ts`
 * (`choice: "a"`) but applies it in one pass over `_inbox/` filtered
 * by the `scoring.ts` heuristic. Operator runs this once per
 * adoption to drain the obvious classifications, then triages the
 * medium / low-confidence remainder interactively via the existing
 * cairn-attention skill.
 *
 * Design:
 *   - Score each draft from frontmatter + body (prose, raw block) so
 *     it can run against drafts written before the scoring pipeline
 *     existed (back-compat for v0.3.6 adoptions).
 *   - High-confidence DEC drafts: move `_inbox/<id>.draft.md`
 *     → `<id>.md`, flip `status:` frontmatter to `accepted`, and
 *     stamp `capture_confidence: high`. Rebuild
 *     `decisions.ledger.yaml` once at the end.
 *   - Medium / low-confidence DEC drafts: stay in `_inbox/` but
 *     get `capture_confidence` stamped so the cairn-attention skill
 *     can prioritize what to surface first.
 *   - Invariants are already at `status: active` (phase 7b promotes
 *     them on write). Just stamp `capture_confidence` so future
 *     UX can hide low-confidence ones from the active set.
 *
 * Side-effect-only: emits decision_accepted events, runs the source
 * strip-replace pass on accepted source-comment drafts so the §INV /
 * §DEC citations land in the original source.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decisionsDir, invariantsDir } from "../ground/paths.js";
import { writeDecisionsLedger } from "../ground/ledgers.js";
import { withWriteLock } from "../lock.js";
import type { ProjectGlobs } from "../sensors/types.js";
import {
  scoreDecDraft,
  scoreInvariant,
  type DraftConfidence,
} from "./scoring.js";
import { runDecSourceStrip } from "./source-strip.js";

export interface BulkAcceptArgs {
  repoRoot: string;
  /** Project globs sourced from `.cairn/config.yaml`. */
  globs: ProjectGlobs;
  /** Pilot module path (workflow.md `pilot_module`) for scoring bias. */
  pilotModule?: string;
  /**
   * Minimum confidence to auto-accept DEC drafts. Defaults to "high"
   * — only obvious accepts move out of the inbox. "medium" widens
   * acceptance; "low" effectively accepts everything (do not use
   * unless the operator explicitly opts in).
   */
  threshold?: DraftConfidence;
  /** Don't write — just compute counts. Returns the same shape. */
  dryRun?: boolean;
}

export interface BulkAcceptResult {
  decsScanned: number;
  decsAccepted: number;
  decsByConfidence: Record<DraftConfidence, number>;
  acceptedIds: string[];
  invariantsScanned: number;
  invariantsByConfidence: Record<DraftConfidence, number>;
  /**
   * Aggregate count of files where an accepted DEC's source-comment
   * essay was replaced inline with `// §DEC-NNNN`. Mirrors the §INV
   * strip pass that 7b runs at adoption time.
   */
  sourceStripFilesModified: number;
  /** Aggregate count of strip items that landed across all accepted DECs. */
  sourceStripItemsApplied: number;
  /**
   * Per-accepted-id strip outcome reasons when the strip didn't run
   * the happy path (block not found, audit missing, source dirty).
   * Empty when every accept succeeded or no DECs came from source
   * comments.
   */
  sourceStripSkipped: { id: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Score, stamp, and (for high-confidence DECs) accept inbox drafts in
 * bulk. Returns the count summary the CLI / skill renders to the
 * operator.
 */
export async function bulkAcceptObvious(
  args: BulkAcceptArgs,
): Promise<BulkAcceptResult> {
  const threshold = args.threshold ?? "high";
  const dry = args.dryRun ?? false;

  // ── DEC drafts ────────────────────────────────────────────────────
  const inboxDir = join(decisionsDir(args.repoRoot), "_inbox");
  const decResult = {
    decsScanned: 0,
    decsAccepted: 0,
    decsByConfidence: { high: 0, medium: 0, low: 0 } as Record<DraftConfidence, number>,
    acceptedIds: [] as string[],
    sourceStripFilesModified: 0,
    sourceStripItemsApplied: 0,
    sourceStripSkipped: [] as { id: string; reason: string }[],
  };

  if (existsSync(inboxDir)) {
    const entries = readdirSync(inboxDir, { withFileTypes: true });
    const drafts = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".draft.md"),
    );
    decResult.decsScanned = drafts.length;

    if (drafts.length > 0) {
      await withWriteLock(args.repoRoot, () => {
        for (const e of drafts) {
          const abs = join(inboxDir, e.name);
          let raw: string;
          try {
            raw = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          const fm = parseFrontmatter(raw);
          const body = stripFrontmatter(raw);
          const id = stringField(fm, "id") ?? e.name.replace(/\.draft\.md$/, "");
          const sourceFile = stringField(fm, "sourceFile") ?? "";
          const titleFm =
            stringField(fm, "proposedTitle") ?? stringField(fm, "title") ?? "";
          const rationaleFm =
            stringField(fm, "proposedRationale") ?? extractSection(body, "Proposed rationale");
          const proseFromBody = extractSection(body, "Source comment");
          const prose = rationaleFm.length > 0 ? rationaleFm : proseFromBody;
          const score = scoreDecDraft({
            sourceFile,
            prose,
            title: titleFm,
            rawComment: proseFromBody,
            globs: args.globs,
            ...(args.pilotModule !== undefined ? { pilotModule: args.pilotModule } : {}),
          });
          decResult.decsByConfidence[score] += 1;

          // Always stamp the confidence so future passes (and the
          // skill) can read it without re-scoring.
          const stampedFm = { ...fm, capture_confidence: score };
          if (atOrAbove(score, threshold)) {
            // Promote to accepted.
            const acceptedFm = { ...stampedFm, status: "accepted" };
            const acceptedBody = renderDoc(acceptedFm, body);
            const acceptedPath = join(decisionsDir(args.repoRoot), `${id}.md`);
            if (!dry) {
              mkdirSync(dirname(acceptedPath), { recursive: true });
              writeFileSync(acceptedPath, acceptedBody, "utf8");
              try {
                rmSync(abs, { force: true });
              } catch {
                /* best-effort */
              }
              // Source-comment derived DECs: replace the original essay
              // block with `// §DEC-NNNN` so the file ends up carrying
              // the bare cite, mirroring the §INV strip pass that 7b
              // runs at adoption time.
              const captureSource = stringField(stampedFm, "capture_source");
              const blockId = stringField(stampedFm, "blockId");
              if (
                captureSource === "init-source-comments" &&
                blockId !== null
              ) {
                // Source files that came from Phase 7b are already dirty
                // (the INV strip pass mutated them); runDecSourceStrip
                // forces overwrite for the target file so the dirty
                // check doesn't bail. Operator consented to source
                // mutation at adoption time.
                const stripOutcome = runDecSourceStrip({
                  repoRoot: args.repoRoot,
                  decId: id,
                  meta: {
                    blockId,
                    sourceFile: stringField(stampedFm, "sourceFile"),
                    captureSource,
                    title: stringField(stampedFm, "title"),
                  },
                });
                decResult.sourceStripFilesModified +=
                  stripOutcome.files_modified;
                decResult.sourceStripItemsApplied +=
                  stripOutcome.items_applied;
                if (
                  stripOutcome.attempted &&
                  stripOutcome.items_applied === 0 &&
                  stripOutcome.reason !== undefined
                ) {
                  decResult.sourceStripSkipped.push({
                    id,
                    reason: stripOutcome.reason,
                  });
                } else if (!stripOutcome.attempted && stripOutcome.reason !== undefined) {
                  decResult.sourceStripSkipped.push({
                    id,
                    reason: stripOutcome.reason,
                  });
                }
              }
            }
            decResult.decsAccepted += 1;
            decResult.acceptedIds.push(id);
          } else {
            // Stay in inbox; persist confidence stamp so the skill
            // can sort/show it.
            const stampedDoc = renderDoc(stampedFm, body);
            if (!dry) {
              writeFileSync(abs, stampedDoc, "utf8");
            }
          }
        }
        // Rebuild the ledger once at the end so accepted DECs surface
        // in `cairn_decisions_in_scope` immediately.
        if (!dry && decResult.decsAccepted > 0) {
          try {
            writeDecisionsLedger({ repoRoot: args.repoRoot });
          } catch {
            /* best-effort */
          }
        }
      });
    }
  }

  // ── Invariants ────────────────────────────────────────────────────
  // Already at status: active on disk. Just stamp confidence so the
  // attention skill can hide / down-weight low-confidence ones.
  const invDir = invariantsDir(args.repoRoot);
  const invResult = {
    invariantsScanned: 0,
    invariantsByConfidence: { high: 0, medium: 0, low: 0 } as Record<DraftConfidence, number>,
  };
  if (existsSync(invDir)) {
    const invEntries = readdirSync(invDir, { withFileTypes: true });
    const invFiles = invEntries.filter(
      (e) => e.isFile() && /^INV-[0-9a-f]{7,}\.md$/.test(e.name),
    );
    invResult.invariantsScanned = invFiles.length;

    if (invFiles.length > 0 && !dry) {
      await withWriteLock(args.repoRoot, () => {
        for (const e of invFiles) {
          const abs = join(invDir, e.name);
          let raw: string;
          try {
            raw = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          const fm = parseFrontmatter(raw);
          const body = stripFrontmatter(raw);
          const sourceFile = stringField(fm, "sourceFile") ?? "";
          const titleFm = stringField(fm, "title") ?? "";
          const rawCommentBody = extractSection(body, "Source comment");
          const constraintBody = extractSection(body, "Constraint");
          const prose = constraintBody.length > 0 ? constraintBody : titleFm;
          const score = scoreInvariant({
            sourceFile,
            prose,
            title: titleFm,
            rawComment: rawCommentBody,
            globs: args.globs,
            ...(args.pilotModule !== undefined ? { pilotModule: args.pilotModule } : {}),
          });
          invResult.invariantsByConfidence[score] += 1;
          const stamped = { ...fm, capture_confidence: score };
          const stampedDoc = renderDoc(stamped, body);
          writeFileSync(abs, stampedDoc, "utf8");
        }
      });
    } else if (invFiles.length > 0 && dry) {
      // Dry run still scores so the operator can see the distribution.
      for (const e of invFiles) {
        const abs = join(invDir, e.name);
        let raw: string;
        try {
          raw = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const fm = parseFrontmatter(raw);
        const body = stripFrontmatter(raw);
        const sourceFile = stringField(fm, "sourceFile") ?? "";
        const titleFm = stringField(fm, "title") ?? "";
        const rawCommentBody = extractSection(body, "Source comment");
        const constraintBody = extractSection(body, "Constraint");
        const prose = constraintBody.length > 0 ? constraintBody : titleFm;
        const score = scoreInvariant({
          sourceFile,
          prose,
          title: titleFm,
          rawComment: rawCommentBody,
          globs: args.globs,
          ...(args.pilotModule !== undefined ? { pilotModule: args.pilotModule } : {}),
        });
        invResult.invariantsByConfidence[score] += 1;
      }
    }
  }

  return {
    ...decResult,
    ...invResult,
    dryRun: dry,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function parseFrontmatter(doc: string): Record<string, unknown> {
  const m = doc.match(/^---\n([\s\S]*?)\n---/);
  if (m === null || m[1] === undefined) return {};
  try {
    const parsed = parseYaml(m[1]);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stripFrontmatter(doc: string): string {
  return doc.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function renderDoc(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

function stringField(
  fm: Record<string, unknown>,
  key: string,
): string | null {
  const v = fm[key];
  return typeof v === "string" ? v : null;
}

function extractSection(body: string, header: string): string {
  // Find `## <header>` and return content until the next `## ` block.
  const re = new RegExp(`##\\s+${escapeRegex(header)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const m = body.match(re);
  if (m === null || m[1] === undefined) return "";
  // Strip surrounding code-fence markers if the section is fenced.
  return m[1].replace(/^\s*```[a-z0-9]*\n?/i, "").replace(/```\s*$/, "").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function atOrAbove(score: DraftConfidence, threshold: DraftConfidence): boolean {
  const order: Record<DraftConfidence, number> = { low: 0, medium: 1, high: 2 };
  return order[score] >= order[threshold];
}
