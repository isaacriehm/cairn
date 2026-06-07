/**
 * JSON API for the triage GUI. Routes mirror the existing attention
 * MCP handlers (resolve / bulk-accept / dedup / restore) so all writes
 * funnel through `withWriteLock`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { bulkAcceptObvious } from "../bulk-accept.js";
import type { DraftConfidence } from "../scoring.js";
import { findDuplicateClusters, type DraftRef } from "../dedup.js";
import { restoreDec } from "../restore.js";
import { runDecSourceStrip, parseDraftMeta } from "../source-strip.js";
import {
  decisionsDir,
  decisionsLedgerPath,
  writeDecisionsLedger,
  parseFrontmatterRecord,
} from "@isaacriehm/cairn-state";
import { withWriteLock } from "../../lock.js";
import { writeInvalidationEvent } from "../../events/index.js";
import { logger } from "../../logger.js";
import type { ProjectGlobs } from "../../sensors/types.js";

const log = logger("attention.serve.api");

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
const BODY_TIMEOUT_MS = 10_000;

const BulkAcceptInput = z.object({
  threshold: z.enum(["high", "medium", "low"]).optional(),
  dryRun: z.boolean().optional(),
});

const ClusterMergeInput = z.object({
  survivor_id: z.string(),
  member_ids: z.array(z.string()).optional(),
});

const EditDraftInput = z.object({
  title: z.string().optional(),
  body_markdown: z.string().optional(),
});

const ConfigSchema = z.object({
  project_globs: z.object({
    route_handler_globs: z.array(z.string()).optional(),
    dto_globs: z.array(z.string()).optional(),
    generator_source_globs: z.array(z.string()).optional(),
    high_stakes_globs: z.array(z.string()).optional(),
  }).optional(),
  off_limits: z.array(z.string()).optional(),
}).passthrough();

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
  token: string;
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
  const parsedUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
  
  // Security: Validate Token
  const queryToken = parsedUrl.searchParams.get("token");
  const authHeader = req.headers["authorization"];
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  
  if (queryToken !== ctx.token && bearerToken !== ctx.token) {
    return sendJson(res, 403, { ok: false, error: "forbidden: invalid token" });
  }

  try {
    if (parsedUrl.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, await buildState(ctx));
    }
    if (parsedUrl.pathname === "/api/heartbeat" && req.method === "POST") {
      return sendJson(res, 200, { ok: true });
    }
    if (parsedUrl.pathname === "/api/done" && req.method === "POST") {
      ctx.onDone();
      return sendJson(res, 200, { ok: true, ...ctx.counters });
    }
    if (parsedUrl.pathname === "/api/bulk-accept" && req.method === "POST") {
      const bodyRaw = await readJsonBody(req);
      const parsed = BulkAcceptInput.safeParse(bodyRaw);
      if (!parsed.success) {
        return sendJson(res, 400, { ok: false, error: "invalid input" });
      }
      const threshold = parsed.data.threshold ?? "high";
      const dryRun = parsed.data.dryRun === true;
      const result = await bulkAcceptObvious({
        repoRoot: ctx.repoRoot,
        globs: await loadGlobs(ctx.repoRoot),
        threshold,
        dryRun,
      });
      if (!dryRun) ctx.counters.accepted += result.decsAccepted;
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (parsedUrl.pathname === "/api/cluster/merge" && req.method === "POST") {
      const bodyRaw = await readJsonBody(req);
      const parsed = ClusterMergeInput.safeParse(bodyRaw);
      if (!parsed.success) {
        return sendJson(res, 400, { ok: false, error: "invalid input" });
      }
      const survivor = parsed.data.survivor_id;
      const members = parsed.data.member_ids ?? [];
      if (!survivor.startsWith("DEC-")) {
        return sendJson(res, 400, { ok: false, error: "missing survivor_id" });
      }
      let rejectedCount = 0;
      for (const m of members) {
        if (m === survivor) continue;
        const ok = await rejectDraft(ctx.repoRoot, m);
        if (ok) rejectedCount += 1;
      }
      ctx.counters.merged += rejectedCount;
      return sendJson(res, 200, { ok: true, survivor_id: survivor, rejected: rejectedCount });
    }

    // /api/draft/:id/<accept|reject|edit>
    const draftMatch = parsedUrl.pathname.match(/^\/api\/draft\/(DEC-[0-9a-f]{7,})\/(accept|reject|edit)$/);
    if (draftMatch !== null && req.method === "POST") {
      const id = draftMatch[1];
      const action = draftMatch[2];
      if (id === undefined || action === undefined) {
        return sendJson(res, 400, { ok: false, error: "invalid path" });
      }
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
        const bodyRaw = await readJsonBody(req);
        const parsed = EditDraftInput.safeParse(bodyRaw);
        if (!parsed.success) {
          return sendJson(res, 400, { ok: false, error: "invalid input" });
        }
        const result = await editDraft(ctx.repoRoot, id, parsed.data);
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
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;

    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("body timeout"));
    }, BODY_TIMEOUT_MS);

    req.on("data", (c) => {
      if (!(c instanceof Buffer)) {
        return;
      }
      bytesReceived += c.length;
      if (bytesReceived > MAX_BODY_BYTES) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.on("end", () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function loadGlobs(repoRoot: string): Promise<ProjectGlobs> {
  const cfgPath = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(cfgPath)) return {};
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = parseYaml(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) return {};
    
    const cfg = result.data;
    const globs: ProjectGlobs = {};
    const projectGlobs = cfg.project_globs;
    if (projectGlobs !== undefined) {
      if (projectGlobs.route_handler_globs) globs.route_handler_globs = projectGlobs.route_handler_globs;
      if (projectGlobs.dto_globs) globs.dto_globs = projectGlobs.dto_globs;
      if (projectGlobs.generator_source_globs) globs.generator_source_globs = projectGlobs.generator_source_globs;
      if (projectGlobs.high_stakes_globs) globs.high_stakes_globs = projectGlobs.high_stakes_globs;
    }
    if (cfg.off_limits) globs.off_limits = cfg.off_limits;
    return globs;
  } catch {
    return {};
  }
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
        raw = await readFile(abs, "utf8");
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
        confidence: stringField(fm, "capture_confidence") as DraftConfidence | null,
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
  return await withWriteLock(repoRoot, async () => {
    await mkdir(dirname(acceptedPath), { recursive: true });
    const draft = await readFile(inboxPath, "utf8");
    const meta = parseDraftMeta(draft);
    const promoted = draft.replace(
      /^status:\s*draft(?:-from-[a-z-]+)?\b/m,
      "status: accepted",
    );
    await writeFile(acceptedPath, promoted, "utf8");
    try {
      await rm(inboxPath, { force: true });
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
  return await withWriteLock(repoRoot, async () => {
    await rename(inboxPath, rejectedPath);
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
  input: z.infer<typeof EditDraftInput>,
): Promise<{ ok: boolean; error?: string }> {
  const decDir = decisionsDir(repoRoot);
  const inboxPath = join(decDir, "_inbox", `${id}.draft.md`);
  if (!existsSync(inboxPath)) return { ok: false, error: "draft missing" };
  const newTitle = input.title ?? null;
  const newRationale = input.body_markdown ?? null;
  if (newTitle === null && newRationale === null) {
    return { ok: false, error: "no fields to update" };
  }
  return await withWriteLock(repoRoot, async () => {
    let raw = await readFile(inboxPath, "utf8");
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
      const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const fm = fmMatch?.[0] ?? "";
      raw = `${fm}\n# ${id}\n\n## Proposed rationale\n\n${newRationale}\n`;
    }
    await writeFile(inboxPath, raw, "utf8");
    return { ok: true };
  });
}


function stripFrontmatter(doc: string): string {
  return doc.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function stringField(
  fm: Record<string, unknown>,
  key: string,
): string | null {
  const v = fm[key];
  return typeof v === "string" ? v : null;
}
