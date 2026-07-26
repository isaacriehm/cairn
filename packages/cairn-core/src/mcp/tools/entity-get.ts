import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import {
  DecisionFrontmatter,
  InvariantFrontmatter,
  decisionsDir,
  invariantsDir,
  parseFrontmatter,
} from "@isaacriehm/cairn-state";
import { mcpError } from "../errors.js";
import { decisionGetInput, invariantGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
}

type EntityKind = "decision" | "invariant";

const KIND_CONFIG = {
  decision: {
    prefix: "DEC-",
    otherPrefix: "INV-",
    otherTool: "cairn_invariant_get",
    dir: decisionsDir,
    frontmatter: DecisionFrontmatter,
    notFoundCode: "DECISION_NOT_FOUND" as const,
    notFoundHint:
      "Real ids are content-addressed (DEC-<7-hex>); sequential placeholders like DEC-0001 don't exist. Try `cairn_search` or `cairn_in_scope` to find the right id.",
    wrongKindMsg: (id: string) =>
      `${id} is an invariant id — call \`cairn_invariant_get({id: "${id}"})\` instead.`,
    validationMsg: (id: string) =>
      `id ${id} is not a decision id — decisions look like DEC-<7-hex>.`,
    missingDirMsg: (dir: string) => `No decisions directory at ${dir}`,
    idFilenameRe: /^(DEC-[0-9a-f]{7,})\.md$/,
    draftFilenameRe: /^(DEC-[0-9a-f]{7,})\.draft\.md$/,
  },
  invariant: {
    prefix: "INV-",
    otherPrefix: "DEC-",
    otherTool: "cairn_decision_get",
    dir: invariantsDir,
    frontmatter: InvariantFrontmatter,
    notFoundCode: "INVARIANT_NOT_FOUND" as const,
    notFoundHint: "",
    wrongKindMsg: (id: string) =>
      `${id} is a decision id — call \`cairn_decision_get({id: "${id}"})\` instead.`,
    validationMsg: (id: string) =>
      `id ${id} is not an invariant id — invariants look like INV-<7-hex>.`,
    missingDirMsg: () => "No invariants directory",
    idFilenameRe: /^(INV-[0-9a-f]{7,})\.md$/,
    draftFilenameRe: /^(INV-[0-9a-f]{7,})\.draft\.md$/,
  },
} as const;

function collectExistingIds(
  kind: EntityKind,
  dirs: string[],
): string[] {
  const cfg = KIND_CONFIG[kind];
  const ids: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d, { withFileTypes: true, encoding: "utf8" })) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const m = f.name.match(cfg.idFilenameRe) ?? f.name.match(cfg.draftFilenameRe);
        if (m?.[1]) ids.push(m[1]);
      }
    } catch {
      // ignore — caller already gated on existsSync
    }
  }
  return ids.sort();
}

function formatDecision(fm: ReturnType<typeof DecisionFrontmatter.parse>, body: string): unknown {
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    ...(fm.scope_globs !== undefined ? { scope_globs: fm.scope_globs } : {}),
    ...(fm.supersedes !== undefined ? { supersedes: fm.supersedes } : {}),
    ...(fm.superseded_by !== undefined ? { superseded_by: fm.superseded_by } : {}),
    ...(fm.decided_at !== undefined ? { decided_at: fm.decided_at } : {}),
    ...(fm.assertions !== undefined ? { assertions: fm.assertions } : {}),
    ...(fm.human_review_hint !== undefined ? { human_review_hint: fm.human_review_hint } : {}),
    ...(fm.related_invariants !== undefined ? { related_invariants: fm.related_invariants } : {}),
    body_markdown: body,
  };
}

function formatInvariant(fm: ReturnType<typeof InvariantFrontmatter.parse>, body: string): unknown {
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status ?? "active",
    ...(fm.source_run !== undefined ? { source_run: fm.source_run } : {}),
    ...(fm.source_decision !== undefined ? { source_decision: fm.source_decision } : {}),
    ...(fm.introduced_for_bug !== undefined ? { introduced_for_bug: fm.introduced_for_bug } : {}),
    ...(fm.sensor !== undefined ? { sensor: fm.sensor } : {}),
    ...(fm.e2e !== undefined ? { e2e: fm.e2e } : {}),
    ...(fm.naming_convention !== undefined ? { naming_convention: fm.naming_convention } : {}),
    ...(fm.superseded_by !== undefined ? { superseded_by: fm.superseded_by } : {}),
    body_markdown: body,
  };
}

async function entityGetHandler(kind: EntityKind, ctx: McpContext, input: Input): Promise<unknown> {
  const cfg = KIND_CONFIG[kind];
  if (input.id.startsWith(cfg.otherPrefix)) {
    return mcpError(
      "WRONG_TOOL_FOR_KIND",
      cfg.wrongKindMsg(input.id),
    );
  }
  if (!input.id.startsWith(cfg.prefix)) {
    return mcpError("VALIDATION_FAILED", cfg.validationMsg(input.id));
  }

  const dir = cfg.dir(ctx.repoRoot);
  if (!existsSync(dir)) {
    return mcpError(cfg.notFoundCode, cfg.missingDirMsg(dir));
  }

  const inboxDir = join(dir, "_inbox");
  const searchDirs = [dir, inboxDir].filter((d) => existsSync(d));
  for (const searchDir of searchDirs) {
    for (const f of readdirSync(searchDir, { withFileTypes: true, encoding: "utf8" })) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const abs = join(searchDir, f.name);
      const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
      const fm = cfg.frontmatter.safeParse(parsed.frontmatter);
      if (!fm.success) continue;
      if (fm.data.id !== input.id) continue;
      return kind === "decision"
        ? formatDecision(fm.data as ReturnType<typeof DecisionFrontmatter.parse>, parsed.body)
        : formatInvariant(fm.data as ReturnType<typeof InvariantFrontmatter.parse>, parsed.body);
    }
  }

  const msg =
    kind === "decision"
      ? `No decision with id ${input.id}. ${cfg.notFoundHint}`
      : `No invariant with id ${input.id}`;
  const allIds = kind === "decision" ? collectExistingIds(kind, searchDirs) : [];
  return mcpError(
    cfg.notFoundCode,
    msg,
    allIds.length > 0 ? { available_ids_sample: allIds.slice(0, 10) } : undefined,
  );
}

export const decisionGetTool: ToolDef<Input> = {
  name: "cairn_decision_get",
  description:
    "Returns full ADR + assertions block for a decision id. **ID format is `DEC-<7-or-more-hex-chars>` (e.g. `DEC-0ae6a8b`), content-addressed — sequential placeholders like `DEC-0001` do not exist; do not invent them.** Resolves both accepted decisions (`.cairn/ground/decisions/<id>.md`) and pending drafts (`_inbox/<id>.draft.md`); the response's `status` field tells the caller which layer the decision came from. Use `cairn_in_scope({path_globs, types: ['decision']})` or `cairn_search(query)` to discover real ids first if you only have a topic.",
  inputSchema: decisionGetInput,
  handler: (ctx, input) => entityGetHandler("decision", ctx, input),
};

export const invariantGetTool: ToolDef<Input> = {
  name: "cairn_invariant_get",
  description: "Returns §INV invariant body + linked sensor + linked e2e by id.",
  inputSchema: invariantGetInput,
  handler: (ctx, input) => entityGetHandler("invariant", ctx, input),
};
