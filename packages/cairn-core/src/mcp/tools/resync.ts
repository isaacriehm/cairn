/**
 * `cairn_resync` — operator-initiated re-discovery that resolves config drift.
 *
 * The config-drift sensor (24h GC) surfaces the gap between declared config and
 * the grown tree as `baseline_finding` nudges; this tool is the verb that turns
 * them into concrete `config.yaml` edits. It writes COMMITTED config, so it is
 * review-class: preview first (default), summarize the proposed edits, get the
 * operator's OK, then call again with `apply: true`. Apply archives the
 * pre-resync config to `.cairn/ground/.archive/` and is idempotent.
 */

import { cairnDir } from "@isaacriehm/cairn-state";
import { runResync, runResyncRecluster } from "../../resync/index.js";
import { runCuratorEmit, runCuratorWalker } from "../../init/index.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { resyncInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

const RECURATE_CAPTURE_SOURCE = "resync-curator";

interface Input {
  apply?: boolean;
  area?: string;
  recluster?: boolean;
  recurate?: "walk" | "emit";
}

export const resyncTool: ToolDef<Input> = {
  name: "cairn_resync",
  description:
    "Resolve surfaced config drift (the config-drift baseline findings) by proposing concrete .cairn/config.yaml edits: add a grown dir to componentDirs, add a new file type to extensions, add an ignored path to off_limits, or drop a dead componentDir. Default previews the edits (mutates nothing) — summarize them and get the operator's OK, then call with apply:true. Apply archives the pre-resync config to .cairn/ground/.archive/ and is idempotent. Pass `area` to scope to one subtree. Pass recluster:true to instead run the LLM re-cluster pass (re-walk prose, Haiku-judge new semantic collisions, rebuild topic-index + anchor-map) — opt-in, spends Haiku on new prose only; preview first, then apply:true to overwrite the (archived) maps. Pass recurate:'walk' (with `area`) to build the curator corpus for re-curation, then — after the cairn-resync skill dispatches curator-map/reduce subagents — recurate:'emit' to write the resulting DEC/INV drafts to _inbox/ (drained via cairn-attention). recurate is skill-driven; don't call it directly.",
  inputSchema: resyncInput,
  handler: async (ctx: McpContext, input: Input): Promise<unknown> => {
    const block = requireBootstrap(ctx.repoRoot);
    if (block !== null) return block;
    const apply = input.apply === true;

    if (input.recurate === "walk") {
      const w = await runCuratorWalker({
        repoRoot: ctx.repoRoot,
        ...(input.area !== undefined ? { area: input.area } : {}),
      });
      return {
        ok: true,
        mode: "recurate-walk",
        area: input.area ?? null,
        curator_dir: cairnDir(ctx.repoRoot, "init", "curator"),
        shards_path: w.shards_path,
        corpus_path: w.corpus_path,
        records_total: w.records_total,
        records_by_kind: w.records_by_kind,
        shards: w.shards,
        note:
          w.shards === 0
            ? "no curatable prose in this area — nothing to dispatch; skip emit"
            : "dispatch curator-map (rounds of 4) + curator-reduce over the shard plan, then call again with recurate:'emit'",
      };
    }

    if (input.recurate === "emit") {
      const e = await runCuratorEmit({
        repoRoot: ctx.repoRoot,
        draft: true,
        captureSource: RECURATE_CAPTURE_SOURCE,
      });
      return {
        ok: true,
        mode: "recurate-emit",
        dec_drafts: e.decsWritten.map((d) => ({ id: d.id, path: d.path, title: d.title })),
        inv_drafts: e.invsWritten.map((d) => ({ id: d.id, path: d.path, title: d.title })),
        dropped: e.dropped,
        drop_reasons: e.dropReasons,
        note: "DEC/INV drafts written to _inbox/ — drain via cairn-attention (accept graduates; reject archives)",
      };
    }

    if (input.recluster === true) {
      const r = await runResyncRecluster({ repoRoot: ctx.repoRoot, dryRun: !apply });
      return {
        ok: true,
        mode: "recluster",
        dry_run: r.dryRun,
        applied: r.applied,
        topics_before: r.topicsBefore,
        topics_after: r.topicsAfter,
        block_count: r.blockCount,
        judge_calls: r.judgeCalls,
        judge_calls_fresh: r.judgeFresh,
        judge_calls_cached: r.judgeCached,
        judge_calls_errors: r.judgeErrors,
        archived_maps: r.archivedMaps,
        note: r.dryRun
          ? "preview only — re-walked + judged but wrote no map; call again with apply:true (and recluster:true) to overwrite the archived maps"
          : undefined,
      };
    }

    const result = runResync({
      repoRoot: ctx.repoRoot,
      dryRun: !apply,
      ...(input.area !== undefined ? { area: input.area } : {}),
    });
    return {
      ok: true,
      dry_run: result.dryRun,
      applied: result.applied,
      proposals: result.proposals.map((p) => ({
        kind: p.kind,
        workspace: p.workspace,
        value: p.value,
        from: p.from,
        detail: p.detail,
      })),
      skipped: result.skipped,
      archived_config: result.archivedConfig,
      archived_entities: result.archivedEntities,
      note:
        result.proposals.length === 0
          ? "no config drift to resolve — config is in sync with the tree"
          : result.dryRun
            ? "preview only — call again with apply:true to write these edits"
            : undefined,
    };
  },
};
