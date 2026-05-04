/**
 * `harness hook write-guard` — PostToolUse hook on the Write/Edit tool.
 *
 * Scans the just-written content for internal-only copy patterns
 * leaking into a user-facing surface (TODO/FIXME comments, harness
 * citations, snake_case identifiers in display strings, internal repo
 * paths). Independent of the copy-safety glob, also looks up the
 * file's scope-index entry and renders a "decisions/invariants in
 * scope" reminder.
 *
 * Both sections are emitted via Claude Code's documented Shape-B
 * `additionalContext` field — the file on disk is NEVER modified, the
 * Write/Edit always succeeds. Guardian is a hint, not a gate.
 *
 * Spec: docs/READ_ENRICHER_SPEC.md "Write Guardian" section.
 */

import { basename, relative } from "node:path";
import { matchAnyGlob } from "../../ground/glob.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import {
  readCopySafetyConfig,
  type CopySafetyConfig,
} from "./allowlist-reader.js";
import { scanForCopyLeakage, type CopyIssue } from "./copy-scanner.js";
import { getScopeIndexEntry } from "./ledger-cache.js";
import type { ScopeIndexHint } from "./legend-builder.js";

interface ClaudePostToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; new_string?: string };
  tool_response?: {
    content?: string;
    text?: string;
    output?: string;
    [key: string]: unknown;
  };
}

interface PostToolUseShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolveP(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      resolveP("");
    });
    if (process.stdin.isTTY) {
      resolveP("");
    }
  });
}

function parsePayload(text: string): ClaudePostToolUsePayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as ClaudePostToolUsePayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function pickContent(
  resp: ClaudePostToolUsePayload["tool_response"],
): string | undefined {
  if (!resp || typeof resp !== "object") return undefined;
  const candidates = ["content", "text", "output"] as const;
  for (const k of candidates) {
    const v = resp[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function computeRelPath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  if (rel.startsWith("..") || rel.length === 0) return filePath;
  return rel.replace(/\\/g, "/");
}

function emitShapeB(additionalContext: string): void {
  const out: PostToolUseShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.stdout.write("\n");
}

function filterAllowed(
  issues: CopyIssue[],
  config: CopySafetyConfig,
): CopyIssue[] {
  if (config.allowlist.length === 0) return issues;
  const allowed = new Set(config.allowlist);
  return issues.filter((i) => !allowed.has(i.match));
}

function renderCopySafetySection(
  fileName: string,
  issues: CopyIssue[],
): string {
  const lines: string[] = [];
  lines.push(
    `⚠ harness:copy-safety — ${issues.length} potential internal copy issue(s) in ${fileName}:`,
  );
  for (const issue of issues) {
    lines.push(
      `  line ${issue.line}  "${issue.match}"  → ${issue.pattern} in user-facing string`,
    );
  }
  return lines.join("\n");
}

function renderScopeSection(scopeHint: ScopeIndexHint): string {
  const lines: string[] = [];
  lines.push("ℹ harness:scope — this file has rules in scope:");
  if (scopeHint.decisions.length > 0) {
    lines.push(`  decisions: ${scopeHint.decisions.join(", ")}`);
  }
  if (scopeHint.invariants.length > 0) {
    const formatted = scopeHint.invariants
      .map((v) => (v.startsWith("§") ? v : `§${v}`))
      .join(", ");
    lines.push(`  invariants: ${formatted}`);
  }
  return lines.join("\n");
}

export async function runWriteGuardian(): Promise<void> {
  try {
    const raw = await readStdin();
    const payload = parsePayload(raw);

    const toolName = payload.tool_name;
    if (toolName !== "Write" && toolName !== "Edit") {
      emitShapeB("");
      return;
    }

    const filePath =
      typeof payload.tool_input?.file_path === "string"
        ? payload.tool_input.file_path
        : undefined;
    if (filePath === undefined) {
      emitShapeB("");
      return;
    }

    let content = pickContent(payload.tool_response);
    if (
      (content === undefined || content.length === 0) &&
      toolName === "Edit"
    ) {
      const ns = payload.tool_input?.new_string;
      if (typeof ns === "string" && ns.length > 0) content = ns;
    }
    if (content === undefined || content.length === 0) {
      emitShapeB("");
      return;
    }

    const repoRoot = resolveRepoRoot(filePath);
    if (repoRoot === null) {
      emitShapeB("");
      return;
    }

    const relPath = computeRelPath(repoRoot, filePath);
    const config = readCopySafetyConfig(repoRoot);
    const inGlobs =
      config.enabled && matchAnyGlob(relPath, config.globs);

    let issues: CopyIssue[] = [];
    if (inGlobs) {
      const raw = scanForCopyLeakage(content, filePath);
      issues = filterAllowed(raw, config);
    }

    const cachedEntry = getScopeIndexEntry(repoRoot, relPath);
    const scopeHint: ScopeIndexHint | null =
      cachedEntry !== null
        ? {
            decisions: cachedEntry.decisions,
            invariants: cachedEntry.invariants,
          }
        : null;

    const sections: string[] = [];
    if (issues.length > 0) {
      sections.push(renderCopySafetySection(basename(filePath), issues));
    }
    if (scopeHint !== null) {
      sections.push(renderScopeSection(scopeHint));
    }

    if (sections.length === 0) {
      emitShapeB("");
      return;
    }

    const block =
      sections.join("\n\n") + "\n\nWrite succeeded. Review before committing.";
    emitShapeB(block);
  } catch {
    // Defer-fail gracefully — guardian is a hint, NOT a gate.
    try {
      emitShapeB("");
    } catch {
      // Last-resort: nothing we can do.
    }
  }
}
