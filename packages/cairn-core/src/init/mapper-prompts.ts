/**
 * Mapper schema + system prompt + user-prompt builder.
 *
 * The chunked parallel mapper (`mapper-parallel.ts`) operates per-module on a
 * subset of these inputs; the `cairn scope rebuild` CLI consumes the full
 * surface to regenerate `scope_index.yaml` against an existing project. Both
 * paths share the same JSON schema + system prompt to guarantee identical
 * output shape.
 */

import type { DetectionResult } from "./types.js";
import type { RepoSummary } from "./walker.js";

export const MAPPER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    domain_summary: { type: "string" },
    key_modules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          purpose: { type: "string" },
        },
        required: ["name", "path", "purpose"],
      },
    },
    route_handler_globs: { type: "array", items: { type: "string" } },
    dto_globs: { type: "array", items: { type: "string" } },
    generator_source_globs: { type: "array", items: { type: "string" } },
    high_stakes_globs: { type: "array", items: { type: "string" } },
    off_limits_globs: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    scope_index: {
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              decisions: { type: "array", items: { type: "string" } },
              invariants: { type: "array", items: { type: "string" } },
              unscoped: { type: "boolean" },
            },
            required: ["decisions", "invariants"],
          },
        },
      },
      required: ["files"],
    },
  },
  required: [
    "domain_summary",
    "key_modules",
    "route_handler_globs",
    "dto_globs",
    "generator_source_globs",
    "high_stakes_globs",
    "off_limits_globs",
    "notes",
  ],
} as const;

export const MAPPER_SYSTEM_PROMPT = [
  "You are the INIT MAPPER for a code-agent cairn adopting a new project.",
  "",
  "Your job: read a structural inventory of an unknown project (top-level dirs, package manifests, framework signals, file-extension breakdown, notable files and dirs) and produce a structured proposal that lets the cairn run useful sensors against the project's diffs.",
  "",
  "You DO NOT execute code. You DO NOT modify files. You produce one JSON object.",
  "",
  "Required outputs:",
  "",
  "- `domain_summary` — one paragraph (~80-200 words). What does this codebase appear to do? Inferred from package name, README contents (when in a manifest preview), top-level dirs, and manifest deps. State only what the inventory supports; if uncertain, say so.",
  "- `key_modules` — 3-8 modules the cairn should know about. Each `{ name, path, purpose }`. `path` is a directory path that EXISTS in the inventory (no glob); `purpose` is one short sentence.",
  "- `route_handler_globs` — file glob patterns matching HTTP / CLI / RPC / route handlers. Examples: `core/src/**/*.controller.ts` (NestJS), `app/controllers/**/*.rb` (Rails), `apps/api/routes/**/*.py` (FastAPI), `internal/handlers/**/*.go`. EMPTY array if no handlers detected.",
  "- `dto_globs` — globs matching DTO / schema / form-input / request-validator definitions. Examples: `**/*.dto.ts`, `apps/api/schemas/**/*.py`, `core/src/**/zod.ts`, `app/forms/**/*.rb`.",
  "- `generator_source_globs` — globs whose changes mean a generator must re-run. Examples: `core/openapi.json`, `core/src/db/schema.ts` (Drizzle), `**/*.proto`, `prisma/schema.prisma`, `db/structure.sql`. EMPTY if no generators apparent.",
  "- `high_stakes_globs` — globs for high-risk surfaces (auth, billing, multi-tenant boundaries, payments, integrations storing tokens, telephony, anything where a regression leaks user data or charges money). Be conservative; over-flagging dilutes the gate. EMPTY if not clear.",
  "- `off_limits_globs` — globs the cairn MUST NOT touch beyond the generic defaults already in place (`node_modules/**`, `dist/**`, `.git/**`, `.cairn/**`, `.archive/**`, generated artifact dirs are already excluded). Add things like vendored third-party code, copied snapshots, large binary fixtures, anything under a directory the operator should not let an agent rewrite. EMPTY if nothing extra.",
  "- `notes` — anything notable that didn't fit a structured field — e.g., \"truncated at file cap; coverage may be conservative\", \"no test infra detected\", \"monorepo with pnpm-workspace\".",
  "- `scope_index` — forward map from repo-relative file paths to the decisions and invariants whose `scope_globs` apply, keyed by file. Shape: `{ files: { \"<repo-relative-path>\": { decisions: [\"DEC-<hash>\"], invariants: [\"INV-<hash>\"], unscoped?: true } } }`. The user prompt provides a list of in-scope decisions + invariants when ground state already exists; classify which apply to each meaningful source file. Use `unscoped: true` for files that should never carry rules (lockfiles, generated, vendored, dotfile config) so the GC scope-coverage pass doesn't re-flag them. EMPTY `{ files: {} }` is acceptable on first-run adopters with no decisions yet. IDs ONLY in these arrays — never copy titles or descriptive prose.",
  "",
  "Rules:",
  "- Globs MUST start from repo root, no leading slash.",
  "- Use forward slashes only (`/`), never backslashes.",
  "- Use `**` for any-depth wildcards, `*` for single-segment.",
  "- Do not invent paths that aren't in the inventory.",
  "- Prefer EMPTY arrays over guessed entries. The cairn propagates empty fields to operator review; guessed entries silently mislead and the operator may not catch them at adoption time.",
  "- Avoid overly-broad globs like `**/*.ts` for `route_handler_globs` — narrow to the controller / route directory.",
  "- `key_modules.path` MUST appear in the inventory's notable directories or the file-count breakdown.",
  "- Return ONLY the JSON object. No prose, no preamble, no code fences.",
].join("\n");

export function buildMapperUserPrompt(args: {
  detection: DetectionResult;
  summary: RepoSummary;
}): string {
  const d = args.detection;
  const s = args.summary;
  const parts: string[] = [];
  parts.push(`# Project inventory`);
  parts.push("");
  parts.push(`Project slug: ${d.project_slug}`);
  parts.push(`Origin URL: ${d.origin_url ?? "(none — local-only repo)"}`);
  parts.push(
    `Stack signatures (mechanical): ${
      d.stack_signatures.map((sig) => sig.kind).join(", ") || "(none)"
    }`,
  );
  if (d.start_command !== null) {
    parts.push(
      `Start command (detected): ${[d.start_command.command, ...d.start_command.args].join(" ")}`,
    );
  }
  parts.push("");
  parts.push(`## Repo summary`);
  parts.push(`Total files (after caps): ${s.total_files}`);
  parts.push(`Total dirs: ${s.total_dirs}`);
  parts.push(
    `Listing source: ${s.used_git_ls_files ? "git ls-files (gitignore-aware)" : "filesystem walk"}`,
  );
  if (s.truncated_at_file_cap) parts.push(`(truncated at file cap)`);
  if (s.truncated_at_depth_cap)
    parts.push(`(truncated at depth cap — coverage may be conservative)`);
  parts.push("");
  parts.push(`## Top-level entries`);
  parts.push(s.top_level.length === 0 ? "(none)" : s.top_level.join(", "));
  parts.push("");
  parts.push(`## Files per top-level dir (top 30)`);
  for (const [dir, count] of Object.entries(s.by_top_dir)) {
    parts.push(`  - ${dir}/  (${count} files)`);
  }
  parts.push("");
  parts.push(`## File extensions (top 25)`);
  for (const [ext, count] of Object.entries(s.by_extension)) {
    parts.push(`  - ${ext}  (${count})`);
  }
  parts.push("");
  if (s.notable_files.length > 0) {
    parts.push(`## Notable files`);
    for (const f of s.notable_files) parts.push(`  - ${f}`);
    parts.push("");
  }
  if (s.notable_dir_paths.length > 0) {
    parts.push(`## Notable directories (matching framework conventions)`);
    for (const dir of s.notable_dir_paths.slice(0, 80)) parts.push(`  - ${dir}/`);
    parts.push("");
  }
  if (s.framework_signals.length > 0) {
    parts.push(`## Framework signals from manifests`);
    for (const f of s.framework_signals) parts.push(`  - ${f}`);
    parts.push("");
  }
  if (s.package_manifests.length > 0) {
    parts.push(`## Package manifest previews (first 80 lines each)`);
    for (const m of s.package_manifests) {
      parts.push(`### ${m.path}`);
      parts.push("```");
      parts.push(m.preview);
      parts.push("```");
      parts.push("");
    }
  }
  parts.push(`Now produce the JSON object per the schema. No preamble.`);
  return parts.join("\n");
}
