/**
 * JSON API for the triage GUI. Routes mirror the existing attention
 * MCP handlers (resolve / bulk-accept / dedup / restore) so all writes
 * funnel through `withWriteLock`.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { bulkAcceptObvious } from "../bulk-accept.js";
import type { DraftConfidence } from "../scoring.js";
import { findDuplicateClusters, type DraftRef } from "../dedup.js";
import { restoreDec } from "../restore.js";
import { runDecSourceStrip, parseDraftMeta } from "../source-strip.js";
import {
  decisionsDir,
  decisionsLedgerPath,
} from "../../ground/paths.js";
import { writeDecisionsLedger } from "../../ground/ledgers.js";
import { parseFrontmatterRecord } from "../../ground/frontmatter.js";
import { withWriteLock } from "../../lock.js";
import { writeInvalidationEvent } from "../../events/index.js";
import { logger } from "../../logger.js";
import { renameSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectGlobs } from "../../sensors/types.js";

const log = logger("attention.serve.api");

interface Counters {
  accepted: number;
  rejected: number;
  merged: number;
  edited: number;
}

interface ApiCtx {
  repoRoot: string;
  counters: Counters;
  touch: () => void;
  onDone: () => void;
}

/**
 * Top-level dispatch. Always responds with JSON.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiCtx,
): Promise<void> {
  ctx.touch();
  const url = req.url ?? "/";

  try {
    if (url === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, await buildState(ctx));
    }
    if (url === "/api/heartbeat" && req.method === "POST") {
      return sendJson(res, 200, { ok: true });
    }
    if (url === "/api/done" && req.method === "POST") {
      ctx.onDone();
      return sendJson(res, 200, { ok: true, ...ctx.counters });
    }
    if (url === "/api/bulk-accept" && req.method === "POST") {
      const body = await readJsonBody(req);
      const threshold = parseThreshold(body?.threshold);
      const result = await bulkAcceptObvious({
        repoRoot: ctx.repoRoot,
        globs: loadGlobs(ctx.repoRoot),
        threshold,
      });
      ctx.counters.accepted += result.decsAccepted;
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (url === "/api/cluster/merge" && req.method === "POST") {
      const body = await readJsonBody(req);
      const survivor = String(body?.survivor_id ?? "");
      const members = Array.isArray(body?.member_ids) ? body.member_ids : [];
      if (!survivor.startsWith("DEC-")) {
        return sendJson(res, 400, { ok: false, error: "missing survivor_id" });
      }
      let rejected = 0;
      for (const m of members) {
        const id = String(m);
        if (id === survivor) continue;
        const ok = await rejectDraft(ctx.repoRoot, id);
        if (ok) rejected += 1;
      }
      ctx.counters.merged += rejected;
      return sendJson(res, 200, { ok: true, survivor_id: survivor, rejected });
    }

    // /api/draft/:id/<accept|reject|edit>
    const draftMatch = url.match(/^\/api\/draft\/(DEC-[0-9a-f]{7,})\/(accept|reject|edit)$/);
    if (draftMatch !== null && req.method === "POST") {
      const id = draftMatch[1] as string;
      const action = draftMatch[2] as string;
      if (action === "accept") {
        const out = await acceptDraft(ctx.repoRoot, id);
        if (out.ok) ctx.counters.accepted += 1;
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      if (action === "reject") {
        const ok = await rejectDraft(ctx.repoRoot, id);
        if (ok) ctx.counters.rejected += 1;
        return sendJson(res, ok ? 200 : 400, { ok });
      }
      if (action === "edit") {
        const body = await readJsonBody(req);
        const result = await editDraft(ctx.repoRoot, id, body);
        if (result.ok) ctx.counters.edited += 1;
        return sendJson(res, result.ok ? 200 : 400, result);
      }
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "no route" }));
  } catch (err) {
    log.error(
      { url, err: err instanceof Error ? err.message : String(err) },
      "api handler threw",
    );
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : "internal error",
    });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

function parseThreshold(raw: unknown): DraftConfidence {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "high";
}

function loadGlobs(repoRoot: string): ProjectGlobs {
  const cfgPath = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(cfgPath)) return {};
  try {
    const parsed = parseYaml(readFileSync(cfgPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const cfg = parsed as Record<string, unknown>;
    const globs: ProjectGlobs = {};
    const projectGlobs = cfg["project_globs"];
    if (typeof projectGlobs === "object" && projectGlobs !== null) {
      const pg = projectGlobs as Record<string, unknown>;
      const route = arrayOfStrings(pg["route_handler_globs"]);
      if (route.length > 0) globs.route_handler_globs = route;
      const dto = arrayOfStrings(pg["dto_globs"]);
      if (dto.length > 0) globs.dto_globs = dto;
      const gen = arrayOfStrings(pg["generator_source_globs"]);
      if (gen.length > 0) globs.generator_source_globs = gen;
      const high = arrayOfStrings(pg["high_stakes_globs"]);
      if (high.length > 0) globs.high_stakes_globs = high;
    }
    const off = arrayOfStrings(cfg["off_limits"]);
    if (off.length > 0) globs.off_limits = off;
    return globs;
  } catch {
    return {};
  }
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

interface DraftSummary extends DraftRef {
  body: string;
  proposedRationale: string | null;
  mtimeMs: number;
}

async function buildState(ctx: ApiCtx): Promise<unknown> {
  const decDir = decisionsDir(ctx.repoRoot);
  const inboxDir = join(decDir, "_inbox");
  const drafts: DraftSummary[] = [];

  if (existsSync(inboxDir)) {
    const entries = readdirSync(inboxDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".draft.md")) continue;
      const abs = join(inboxDir, e.name);
      let raw: string;
      try {
        raw = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const fm = parseFrontmatterRecord(raw).fm;
      const body = stripFrontmatter(raw);
      const id = stringField(fm, "id") ?? e.name.replace(/\.draft\.md$/, "");
      const title =
        stringField(fm, "proposedTitle") ??
        stringField(fm, "title") ??
        id;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        /* leave 0 */
      }
      drafts.push({
        id,
        path: `.cairn/ground/decisions/_inbox/${e.name}`,
        title,
        sourceFile: stringField(fm, "sourceFile") ?? "",
        source: stringField(fm, "capture_source") ?? "",
        confidence: stringField(fm, "capture_confidence"),
        body,
        proposedRationale: stringField(fm, "proposedRationale"),
        mtimeMs,
      });
    }
    drafts.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  const dedup = findDuplicateClusters({ repoRoot: ctx.repoRoot });

  return {
    drafts,
    clusters: dedup.clusters,
    counts: {
      drafts: drafts.length,
      clusters: dedup.clusters.length,
      reducible: dedup.reducible,
      ...ctx.counters,
    },
  };
}

async function acceptDraft(
  repoRoot: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const decDir = decisionsDir(repoRoot);
  const inboxPath = join(decDir, "_inbox", `${id}.draft.md`);
  const acceptedPath = join(decDir, `${id}.md`);
  if (!existsSync(inboxPath)) {
    return { ok: false, error: `no draft at ${inboxPath}` };
  }
  return await withWriteLock(repoRoot, () => {
    mkdirSync(dirname(acceptedPath), { recursive: true });
    const draft = readFileSync(inboxPath, "utf8");
    const meta = parseDraftMeta(draft);
    const promoted = draft.replace(
      /^status:\s*draft(?:-from-[a-z-]+)?\b/m,
      "status: accepted",
    );
    writeFileSync(acceptedPath, promoted, "utf8");
    try {
      rmSync(inboxPath, { force: true });
    } catch {
      /* best-effort */
    }
    try {
      writeInvalidationEvent(repoRoot, {
        kind: "decision_accepted",
        refs: [{ kind: "decision", id }],
        path: `.cairn/ground/decisions/${id}.md`,
        source: { session_id: null, tool: "cairn_attention_serve" },
      });
    } catch {
      /* best-effort */
    }
    try {
      writeDecisionsLedger({ repoRoot });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "ledger rebuild failed after accept",
      );
    }
    if (
      meta?.captureSource === "init-source-comments" &&
      meta.blockId !== null
    ) {
      runDecSourceStrip({ repoRoot, decId: id, meta });
    }
    return { ok: true };
  });
}

async function rejectDraft(repoRoot: string, id: string): Promise<boolean> {
  const decDir = decisionsDir(repoRoot);
  const inboxPath = join(decDir, "_inbox", `${id}.draft.md`);
  const rejectedPath = join(decDir, "_inbox", `${id}.rejected.md`);
  if (!existsSync(inboxPath)) return false;
  return await withWriteLock(repoRoot, () => {
    renameSync(inboxPath, rejectedPath);
    try {
      writeInvalidationEvent(repoRoot, {
        kind: "decision_rejected",
        refs: [{ kind: "decision", id }],
        path: `.cairn/ground/decisions/_inbox/${id}.rejected.md`,
        source: { session_id: null, tool: "cairn_attention_serve" },
      });
    } catch {
      /* best-effort */
    }
    return true;
  });
}

async function editDraft(
  repoRoot: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const decDir = decisionsDir(repoRoot);
  const inboxPath = join(decDir, "_inbox", `${id}.draft.md`);
  if (!existsSync(inboxPath)) return { ok: false, error: "draft missing" };
  const newTitle = typeof body.title === "string" ? body.title : null;
  const newRationale =
    typeof body.body_markdown === "string" ? body.body_markdown : null;
  if (newTitle === null && newRationale === null) {
    return { ok: false, error: "no fields to update" };
  }
  return await withWriteLock(repoRoot, () => {
    let raw = readFileSync(inboxPath, "utf8");
    if (newTitle !== null) {
      raw = raw.replace(/^title:.*$/m, `title: ${JSON.stringify(newTitle)}`);
      raw = raw.replace(
        /^# DEC-[0-9a-f]{7,} —.*$/m,
        `# ${id} — ${newTitle}`,
      );
    }
    if (newRationale !== null) {
      // Replace the whole body after the frontmatter with the new rationale
      // wrapped in the canonical heading. Preserves frontmatter.
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/);
      const fm = fmMatch?.[0] ?? "";
      raw = `${fm}\n# ${id}\n\n## Proposed rationale\n\n${newRationale}\n`;
    }
    writeFileSync(inboxPath, raw, "utf8");
    return { ok: true };
  });
}


function stripFrontmatter(doc: string): string {
  return doc.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function stringField(
  fm: Record<string, unknown>,
  key: string,
): string | null {
  const v = fm[key];
  return typeof v === "string" ? v : null;
}
