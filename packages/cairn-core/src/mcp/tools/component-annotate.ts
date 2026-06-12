/**
 * `cairn_component_annotate` — the context engine's stage-3 write path.
 *
 * The agent supplies JUDGMENT (category, purpose, aliases, which props
 * are public); the server holds the MECHANICS + truth: it validates the
 * export symbol against the code, validates the category against the
 * project enum, formats the canonical `@cairn` header (block form for
 * C-style langs, hash form for the rest), writes it above the export,
 * and rebuilds the index + singleton §INV. The agent never sees the
 * header grammar — the format is structurally impossible to get wrong.
 *
 * Committed mode writes the in-file header (the SoT). Ghost mode has no
 * in-file SoT, so it delegates to `cairn_component_register` (registry
 * write, no source edit).
 *
 * Spec: docs/CONTEXT_ENGINE.md ("semantics in, server writes"),
 * CAIRN_REBUILD §8d / D7–D9.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractExportNames,
  hasComponentConfig,
  isGhost,
  loadComponentsConfig,
  parseComponentHeader,
  profileForFile,
  type CommentForm,
  type NormalizedComponentsConfig,
} from "@isaacriehm/cairn-state";
import { emitComponentStore } from "../../components/emit.js";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { componentAnnotateInput } from "../schemas.js";
import { componentRegisterTool } from "./component-register.js";
import type { ToolDef } from "./types.js";

interface Input {
  file: string;
  export_name: string;
  category: string;
  purpose: string;
  aliases: string[];
  public_props?: string[];
  uses?: string[];
  status?: "stable" | "wip" | "deprecated";
  singleton?: boolean;
  workspace?: string;
}

/** Allowed categories for the workspace owning `rel` (longest-prefix). */
function categoriesForFile(
  config: NormalizedComponentsConfig,
  rel: string,
): string[] {
  let best: string[] | null = null;
  let bestLen = -1;
  for (const ws of config.workspaces) {
    for (const dir of ws.componentDirs) {
      if ((rel === dir || rel.startsWith(`${dir}/`)) && dir.length > bestLen) {
        bestLen = dir.length;
        best = ws.categories;
      }
    }
  }
  return best ?? config.workspaces[0]?.categories ?? [];
}

/** Pick the header comment form from the file's language profile. */
function commentFormFor(file: string): CommentForm {
  const forms = profileForFile(file)?.commentForms ?? [];
  if (forms.includes("block")) return "block";
  if (forms.includes("hash")) return "hash";
  if (forms.includes("dash")) return "dash";
  return "block";
}

/** Format the canonical `@cairn` header in the given comment form. */
function formatHeader(input: Input, form: CommentForm): string {
  const tags: string[] = [
    `@cairn ${input.export_name}`,
    `@category ${input.category}`,
    `@purpose ${input.purpose}`,
    `@aliases ${input.aliases.join(", ")}`,
  ];
  if (input.public_props !== undefined && input.public_props.length > 0) {
    tags.push(`@props ${input.public_props.join(", ")}`);
  }
  if (input.uses !== undefined && input.uses.length > 0) {
    tags.push(`@uses ${input.uses.join(", ")}`);
  }
  if (input.status !== undefined) tags.push(`@status ${input.status}`);
  if (input.singleton === true) tags.push("@singleton");

  if (form === "block") {
    return ["/**", ...tags.map((t) => ` * ${t}`), " */"].join("\n");
  }
  const marker = form === "dash" ? "--" : "#";
  return tags.map((t) => `${marker} ${t}`).join("\n");
}

// A leading directive-prologue statement — `"use client"`, `"use server"`,
// `"use strict"`. These MUST stay the file's first statement (React Server
// Components / strict mode break if a comment-bearing header pushes them
// down in some bundlers), so the header is inserted AFTER them.
const DIRECTIVE_RE = /^\s*['"]use [\w-]+['"]\s*;?\s*$/;

/**
 * Insert `header` above the code, but below any shebang and leading
 * directive prologue (`"use client"` etc.) — those must remain the
 * file's first line / first statement.
 */
function insertHeader(source: string, header: string): string {
  const lines = source.split("\n");
  let insertAt = 0;
  if (lines.length > 0 && lines[0]!.startsWith("#!")) insertAt = 1; // shebang
  while (insertAt < lines.length) {
    const line = lines[insertAt]!;
    if (line.trim() === "" || DIRECTIVE_RE.test(line)) {
      insertAt += 1;
      continue;
    }
    break;
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, header, ...after].join("\n");
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const abs = join(ctx.repoRoot, input.file);
  if (!existsSync(abs)) {
    return mcpError(
      "FILE_NOT_FOUND",
      `${input.file} does not exist under the repo root — annotate an existing component file.`,
    );
  }

  // Ghost mode has no in-file SoT — delegate to the registry write path.
  if (isGhost(ctx.repoRoot)) {
    return componentRegisterTool.handler(ctx, {
      file: input.file,
      export_name: input.export_name,
      name: input.export_name,
      category: input.category,
      purpose: input.purpose,
      aliases: input.aliases,
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
      ...(input.singleton !== undefined ? { singleton: input.singleton } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.uses !== undefined ? { uses: input.uses } : {}),
    });
  }

  const config = loadComponentsConfig(ctx.repoRoot);
  if (!hasComponentConfig(config)) {
    return mcpError(
      "NOT_ALLOWED",
      "this repo has no components: config — nothing to annotate.",
    );
  }

  // D9 — category must be in the owning workspace's enum (server owns it).
  const categories = categoriesForFile(config, input.file);
  if (categories.length > 0 && !categories.includes(input.category)) {
    return mcpError(
      "VALIDATION_FAILED",
      `category "${input.category}" is not one of this workspace's categories: ${categories.join(", ")}.`,
    );
  }

  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `could not read ${input.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Idempotent: a file that already carries a `@cairn` header is left
  // untouched — re-writing would create a second header block.
  if (parseComponentHeader(source) !== null) {
    return {
      ok: true,
      file: input.file,
      header_written: false,
      already_headered: true,
    };
  }

  // D7 — export_name must be a real export. When the language profile
  // can detect exports and the claimed name isn't among them, reject;
  // when detection yields nothing (unknown extension) accept best-effort.
  const exports = extractExportNames(source, input.file);
  if (exports.length > 0 && !exports.includes(input.export_name)) {
    return mcpError(
      "VALIDATION_FAILED",
      `export_name "${input.export_name}" is not an export of ${input.file}. Real exports: ${exports.join(", ")}.`,
    );
  }

  const form = commentFormFor(input.file);
  const header = formatHeader(input, form);
  const next = insertHeader(source, header);
  try {
    writeFileSync(abs, next, "utf8");
  } catch (err) {
    return mcpError(
      "INTERNAL_ERROR",
      `could not write ${input.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Rebuild the derived index + promote any @singleton to a hard §INV.
  let indexed = 0;
  try {
    const emit = emitComponentStore(ctx.repoRoot);
    indexed = emit.indexed;
  } catch {
    // header is written + valid; index rebuild is best-effort here
    // (the pre-commit sweep rebuilds deterministically anyway).
  }

  return {
    ok: true,
    name: input.export_name,
    category: input.category,
    file: input.file,
    header_written: true,
    indexed,
  };
}

export const componentAnnotateTool: ToolDef<Input> = {
  name: "cairn_component_annotate",
  description:
    "Register a component by writing its canonical `@cairn` header. Supply judgment only — file, export_name, category (one of the workspace's categories), a one-line purpose, and ≥2 aliases; optional public_props/uses/status/singleton. The server validates the export + category against the code, formats + inserts the header, and rebuilds the registry. Committed projects write the in-file header; ghost projects route to the registry. This is the server-driven replacement for hand-writing `@cairn` headers.",
  inputSchema: componentAnnotateInput,
  handler,
};
