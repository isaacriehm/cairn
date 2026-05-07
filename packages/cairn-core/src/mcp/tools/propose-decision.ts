/**
 * `cairn_propose_decision` — promote a topic-index candidate (slug)
 * into a DEC draft under `.cairn/ground/decisions/_inbox/`.
 *
 * 6 / §5.4. The AI-curator path. Body is
 * ALWAYS verbatim from `readSotBody` so the resulting draft's
 * `sot_content_hash` matches the source paragraph the agent saw — no
 * paraphrasing, no AI-generated prose. The drift sensor depends on
 * this hash.
 *
 * Refusal modes (returned as `{ ok: false, reason: <kind> }`):
 *   - `not_found`  — slug not present in the topic-index.
 *   - `rejected`   — slug appears in `.cairn/ground/_rejected.yaml`.
 *   - `unreadable` — `readSotBody` returned null (anchor-map missing
 *                    or the source file disappeared).
 *   - `drifted`    — body hash no longer matches `entry.content_hash`.
 *                    The operator (or another agent) edited the source
 *                    paragraph after phase 5b walked it. Caller should
 *                    re-run `cairn index` and re-evaluate.
 *
 * Idempotent: a slug that already has a `dec_id` returns
 *   `{ ok: true, dec_id, path, warning: "...already exists" }` rather
 *   than re-emitting. The locked "DO NOT enforce" wording goes back
 *   to the agent verbatim so it cannot accidentally cite the draft as
 *   accepted policy.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  bodyContentHash,
  decisionsDir,
  deriveDecId,
  readAnchorMap,
  readRejectedYaml,
  readTopicIndex,
  setTopic,
  writeFileCandidatesMap,
  writeTopicIndex,
  type TopicIndexEntry,
} from "../../ground/index.js";
import { scanExistingDecisionIds } from "../../decision-capture/index.js";
import { withWriteLock } from "../../lock.js";
import { readSotBody } from "../../init/sot-emit.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { proposeDecisionInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  slug: string;
  title?: string;
  kind?: "decision" | "rule";
}

const CAPTURE_SOURCE = "ai-proposed";
const DECIDED_BY = "ai-curator";

interface ProposeDecisionResult {
  ok: boolean;
  dec_id?: string;
  path?: string;
  reason?: "not_found" | "rejected" | "unreadable" | "drifted";
  detail?: string;
  warning?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  return withWriteLock(ctx.repoRoot, () => {
    const topicIndex = readTopicIndex(ctx.repoRoot);
    const entry = topicIndex.topics[input.slug];
    if (entry === undefined) {
      return {
        ok: false,
        reason: "not_found",
        detail: `slug "${input.slug}" not in topic-index`,
      } satisfies ProposeDecisionResult;
    }

    if (entry.dec_id !== undefined) {
      return {
        ok: true,
        dec_id: entry.dec_id,
        path: relativeInboxPath(entry.dec_id, ctx.repoRoot),
        warning: `DEC draft already exists for slug ${input.slug}; returning existing id ${entry.dec_id}.`,
      } satisfies ProposeDecisionResult;
    }

    const rejected = readRejectedYaml(ctx.repoRoot);
    const reject = rejected.get(input.slug);
    if (reject !== undefined) {
      return {
        ok: false,
        reason: "rejected",
        detail: reject.reason,
      } satisfies ProposeDecisionResult;
    }

    const anchorMap = readAnchorMap(ctx.repoRoot);
    const body = readSotBody(ctx.repoRoot, entry, anchorMap);
    if (body === null) {
      return {
        ok: false,
        reason: "unreadable",
        detail: "anchor-map missing or source body unreadable",
      } satisfies ProposeDecisionResult;
    }

    // Drift check — the topic-index records the body hash phase 5b
    // saw. If the operator (or another agent) has since edited the
    // paragraph, the AI may be promoting outdated content. Surface it
    // and bounce the caller; correct path is `cairn index` then retry.
    if (entry.content_hash !== undefined) {
      const currentHash = bodyContentHash(body);
      if (currentHash !== entry.content_hash) {
        return {
          ok: false,
          reason: "drifted",
          detail:
            "Source file modified since index build. Run 'cairn index' to refresh, then retry.",
        } satisfies ProposeDecisionResult;
      }
    }

    const titleSeed = input.title !== undefined && input.title.trim().length > 0
      ? input.title.trim()
      : firstLineFallback(body);
    const sotPath = entryToSotPath(entry);

    const existingIds = scanExistingDecisionIds(ctx.repoRoot);
    const decId = allocateUniqueDecId(
      { sot_path: sotPath, title: titleSeed, capture_source: CAPTURE_SOURCE },
      existingIds,
    );

    writeDraftToInbox({
      repoRoot: ctx.repoRoot,
      id: decId,
      title: titleSeed,
      body,
      sot_path: sotPath,
      source_file: entry.sot_source,
    });

    const updatedTopicIndex = setTopic(topicIndex, input.slug, {
      ...entry,
      dec_id: decId,
    });
    writeTopicIndex(ctx.repoRoot, updatedTopicIndex);
    // Refresh the per-file candidate count map so the read-enrich
    // hint reflects the post-promote state next time the agent reads
    // the file.
    writeFileCandidatesMap(ctx.repoRoot, updatedTopicIndex);

    return {
      ok: true,
      dec_id: decId,
      path: relativeInboxPath(decId, ctx.repoRoot),
      warning:
        `Created draft from slug ${input.slug}. Status=draft, pending operator review via cairn-attention. ` +
        `DO NOT enforce this rule yet — proposal only. You MAY cite as "proposed (${decId}, draft)".`,
    } satisfies ProposeDecisionResult;
  });
}

interface WriteDraftArgs {
  repoRoot: string;
  id: string;
  title: string;
  body: string;
  sot_path: string;
  source_file: string;
}

function writeDraftToInbox(args: WriteDraftArgs): string {
  const inboxDir = join(decisionsDir(args.repoRoot), "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const abs = join(inboxDir, `${args.id}.draft.md`);
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.title,
    type: "adr",
    status: "draft",
    audience: "dual",
    generated: now,
    "verified-at": now,
    decided_at: now,
    decided_by: DECIDED_BY,
    sot_kind: "path",
    sot_path: args.sot_path,
    sot_content_hash: bodyContentHash(args.body),
    capture_source: CAPTURE_SOURCE,
    source_file: args.source_file,
  };
  const out: string[] = [];
  out.push("---");
  out.push(stringifyYaml(fm).trimEnd());
  out.push("---");
  out.push("");
  out.push(args.body.trimEnd());
  out.push("");
  writeFileSync(abs, out.join("\n"), "utf8");
  return abs;
}

function relativeInboxPath(id: string, _repoRoot: string): string {
  // Project-relative path so callers can hand it straight to Read or
  // `cairn_decision_get` without prefix juggling.
  return `.cairn/ground/decisions/_inbox/${id}.draft.md`;
}

function entryToSotPath(entry: TopicIndexEntry): string {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot === undefined) return entry.sot_source;
  if (sot.anchor !== undefined && sot.anchor.length > 0) {
    return `${entry.sot_source}#${sot.anchor}`;
  }
  return entry.sot_source;
}

function firstLineFallback(body: string): string {
  const first = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^#+\s*/, "").trim().slice(0, 120) || "(untitled)";
}

/**
 * Mirrors `phase 6`'s id allocator: derive a content-stable id, fall
 * back to `<title> #N` suffixing on the (vanishingly rare) collision
 * against an existing on-disk DEC.
 */
function allocateUniqueDecId(
  input: { sot_path: string; title: string; capture_source: string },
  existingIds: Set<string>,
): string {
  const id = deriveDecId(input);
  if (!existingIds.has(id)) {
    existingIds.add(id);
    return id;
  }
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const tagged = deriveDecId({ ...input, title: `${input.title} #${suffix}` });
    if (!existingIds.has(tagged)) {
      existingIds.add(tagged);
      return tagged;
    }
  }
  existingIds.add(id);
  return id;
}

export const proposeDecisionTool: ToolDef<Input> = {
  name: "cairn_propose_decision",
  description:
    "Promote a topic-index candidate (slug) to a DEC draft in `_inbox/`. Body is verbatim via readSotBody; AI may only supply a title. Refuses on rejected, drifted, or unreadable slugs. Returns a locked 'DO NOT enforce — proposal only' warning so the draft is never miscited as accepted policy.",
  inputSchema: proposeDecisionInput,
  handler,
};
