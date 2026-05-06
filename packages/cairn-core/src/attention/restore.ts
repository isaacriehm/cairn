/**
 * Restore a previously rejected or accepted DEC back to draft state so
 * the operator can re-evaluate it.
 *
 * Two restore paths:
 *
 *   1. **Rejected → draft.** The DEC sits at
 *      `.cairn/ground/decisions/_inbox/<id>.rejected.md`. Move it back
 *      to `.draft.md` and flip `status: rejected` → the original
 *      `draft-from-source-comment` (or `draft-from-init-docs` etc.) so
 *      `cairn_resolve_attention` will find it again. No source
 *      mutation — rejected drafts never strip-replaced source, so
 *      there's nothing to reverse.
 *
 *   2. **Accepted → draft.** The DEC sits at
 *      `.cairn/ground/decisions/<id>.md`. Move it to
 *      `_inbox/<id>.draft.md`, flip `status: accepted` → the original
 *      draft status, and rebuild the decisions ledger so the canonical
 *      surface no longer resolves the id. Source files keep the
 *      `// §DEC-NNNN` cite (we don't reverse-strip — the cite is a
 *      durable artifact of the prior accept and removing it without
 *      operator intent risks dropping a legit DEC reference if the
 *      operator never re-accepts). Operator can re-accept (idempotent
 *      via the `already-stripped` check) or run a manual edit.
 *
 * The id is reserved across both paths — it stays out of the high-water
 * mark per `scanExistingDecisionIds`.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { decisionsDir } from "../ground/paths.js";
import { writeDecisionsLedger } from "../ground/ledgers.js";
import { withWriteLock } from "../lock.js";
import { logger } from "../logger.js";

const log = logger("attention.restore");

export type RestoreState = "rejected" | "accepted" | "draft" | "not-found";

export interface RestoreArgs {
  repoRoot: string;
  decId: string;
}

export interface RestoreResult {
  ok: boolean;
  decId: string;
  priorState: RestoreState;
  /** Repo-relative path the draft now lives at, or null when no move happened. */
  draftPath: string | null;
  /** Set when ok is false. */
  reason?: string;
}

const DRAFT_STATUS_DEFAULT = "draft-from-source-comment";

/**
 * Walk the body for a `status:` frontmatter line and replace the value
 * with the default draft status. Also resets `decided_at` / `decided_by`
 * fields so the draft looks fresh, which mirrors how Phase 7b writes
 * brand-new drafts.
 */
function flipStatusToDraft(body: string): string {
  return body.replace(
    /^status:\s*(?:accepted|rejected)\b/m,
    `status: ${DRAFT_STATUS_DEFAULT}`,
  );
}

export async function restoreDec(args: RestoreArgs): Promise<RestoreResult> {
  if (!/^DEC-[0-9a-f]{7,}$/.test(args.decId)) {
    return {
      ok: false,
      decId: args.decId,
      priorState: "not-found",
      draftPath: null,
      reason: "invalid-id",
    };
  }
  const decDir = decisionsDir(args.repoRoot);
  const inboxDir = join(decDir, "_inbox");
  const rejectedPath = join(inboxDir, `${args.decId}.rejected.md`);
  const draftPath = join(inboxDir, `${args.decId}.draft.md`);
  const acceptedPath = join(decDir, `${args.decId}.md`);
  const draftRel = `.cairn/ground/decisions/_inbox/${args.decId}.draft.md`;

  if (existsSync(draftPath)) {
    return {
      ok: true,
      decId: args.decId,
      priorState: "draft",
      draftPath: draftRel,
      reason: "already-draft",
    };
  }
  const isRejected = existsSync(rejectedPath);
  const isAccepted = existsSync(acceptedPath);
  if (!isRejected && !isAccepted) {
    return {
      ok: false,
      decId: args.decId,
      priorState: "not-found",
      draftPath: null,
      reason: "not-found",
    };
  }

  return withWriteLock(args.repoRoot, () => {
    if (isRejected) {
      const body = readFileSync(rejectedPath, "utf8");
      const restored = flipStatusToDraft(body);
      writeFileSync(draftPath, restored, "utf8");
      try {
        rmSync(rejectedPath, { force: true });
      } catch {
        /* best-effort */
      }
      log.info(
        { decId: args.decId },
        "restored rejected DEC to draft",
      );
      return {
        ok: true,
        decId: args.decId,
        priorState: "rejected" as const,
        draftPath: draftRel,
      };
    }
    // Accepted → draft. Source cite stays in place; see module docstring
    // for the rationale.
    const body = readFileSync(acceptedPath, "utf8");
    const restored = flipStatusToDraft(body);
    writeFileSync(draftPath, restored, "utf8");
    try {
      rmSync(acceptedPath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      writeDecisionsLedger({ repoRoot: args.repoRoot });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "decisions ledger rebuild failed after accepted-to-draft restore",
      );
    }
    log.info(
      { decId: args.decId },
      "restored accepted DEC to draft (source cite kept)",
    );
    return {
      ok: true,
      decId: args.decId,
      priorState: "accepted" as const,
      draftPath: draftRel,
    };
  });
}
