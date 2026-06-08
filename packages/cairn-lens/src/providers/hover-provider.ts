/**
 * Hover provider for cairn citation tokens.
 *
 * Triggers on §DEC-<hash>, §INV-<hash>, TODO(TSK-<id>), and `@cairn <Name>`
 * component-registry headers. Renders a Markdown card with resolved
 * title, status, and links to the underlying ground file.
 */

import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";
import { lensLog } from "../debug-log.js";

// Content-addressed bare-token format:  §DEC-a3f7b2c  or  # §DEC-a3f7b2c
// Width + boundary disciplined to match decoration-provider; see
// providers/decoration-provider.ts for the rationale.
const DECISION_TOKEN_RE = /§(DEC-[0-9a-f]{7,})\b/g;
const INVARIANT_TOKEN_RE = /§(INV-[0-9a-f]{7,})\b/g;
const TASK_TOKEN_RE = /TODO\(TSK-[A-Za-z0-9_-]+\)/g;
// `@cairn <ExportName>` registry header — whitespace then an identifier.
// Deliberately excludes the colon-form `@cairn:decision` / `@cairn:rule`
// SoT markers (those can never be whitespace-then-identifier).
const COMPONENT_HEADER_RE = /@cairn[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/g;

interface TokenMatch {
  kind: "decision" | "invariant" | "task" | "component";
  id: string; // "DEC-a3f7b2c", "INV-2323232", "TSK-foo", or "<ComponentName>"
  range: vscode.Range;
}

function findTokenAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): TokenMatch | null {
  const line = doc.lineAt(position.line).text;

  for (const m of line.matchAll(DECISION_TOKEN_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        kind: "decision",
        id: m[1] as string, // "DEC-<hash7>"
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  for (const m of line.matchAll(INVARIANT_TOKEN_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        kind: "invariant",
        id: m[1] as string, // "INV-<hash7>"
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  for (const m of line.matchAll(TASK_TOKEN_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      // Inner: TODO(TSK-foo) -> "TSK-foo"
      const inner = m[0].slice(5, -1);
      return {
        kind: "task",
        id: inner,
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  for (const m of line.matchAll(COMPONENT_HEADER_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        kind: "component",
        id: m[1] as string, // "<ComponentName>"
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  return null;
}

export class CitationHoverProvider implements vscode.HoverProvider {
  constructor(private readonly resolver: LensResolver) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    const token = findTokenAt(document, position);
    if (token === null) {
      lensLog(
        `provideHover ${document.uri.fsPath}:${position.line + 1}:${position.character} → no token`,
      );
      return null;
    }
    lensLog(
      `provideHover ${document.uri.fsPath}:${position.line + 1} matched ${token.kind}=${token.id}`,
    );

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;

    if (token.kind === "decision") {
      const r = this.resolver.resolveDecisionBody(token.id);
      const statusLabel =
        r.status === "accepted"
          ? "$(check) accepted"
          : "$(question) not in ledger";
      md.appendMarkdown(`**§${r.id}** — ${escapeMd(r.title)}\n\n`);
      md.appendMarkdown(`${statusLabel}\n\n`);
      if (r.sot_kind === "path" && r.sot_path.length > 0) {
        md.appendMarkdown(`SoT path: \`${escapeMd(r.sot_path)}\`\n\n`);
      }
      if (r.fromCache) {
        md.appendMarkdown(
          "$(warning) source unavailable — cached snapshot\n\n",
        );
      }
      if (r.body.length > 0) {
        md.appendMarkdown(`---\n\n${r.body}\n\n---\n\n`);
      }
      md.appendMarkdown(
        `[Open decisions ledger](${vscode.Uri.file(this.resolver.decisionsLedgerFilePath()).toString()})`,
      );
    } else if (token.kind === "invariant") {
      const r = this.resolver.resolveInvariantBody(token.id);
      const statusLabel =
        r.status === "active"
          ? "$(check) active"
          : r.status === "superseded"
            ? `$(warning) superseded by §${r.supersededBy ?? "?"}`
            : "$(question) not in ledger";
      md.appendMarkdown(`**§${r.id}** — ${escapeMd(r.title)}\n\n`);
      md.appendMarkdown(`${statusLabel}\n\n`);
      if (r.sot_kind === "path" && r.sot_path.length > 0) {
        md.appendMarkdown(`SoT path: \`${escapeMd(r.sot_path)}\`\n\n`);
      }
      if (r.fromCache) {
        md.appendMarkdown(
          "$(warning) source unavailable — cached snapshot\n\n",
        );
      }
      if (r.body.length > 0) {
        md.appendMarkdown(`---\n\n${r.body}\n\n---\n\n`);
      }
      md.appendMarkdown(
        `[Open invariants ledger](${vscode.Uri.file(this.resolver.invariantsLedgerFilePath()).toString()})`,
      );
    } else if (token.kind === "task") {
      const r = this.resolver.resolveTask(token.id);
      const stateLabel =
        r.found === "active"
          ? "$(circle-large-filled) active"
          : r.found === "done"
            ? "$(check-all) done — this TODO can be removed"
            : "$(circle-slash) not in tasks/{active,done}/";
      md.appendMarkdown(`**${r.id}** — ${escapeMd(r.title ?? "(no title)")}\n\n`);
      md.appendMarkdown(`${stateLabel}\n`);
    } else {
      const r = this.resolver.resolveComponent(token.id);
      if (!r.found || r.entry === null) {
        md.appendMarkdown(`**@cairn ${escapeMd(token.id)}**\n\n`);
        md.appendMarkdown(
          "$(question) not in the component registry — rebuild with `cairn components index`\n",
        );
        return new vscode.Hover(md, token.range);
      }
      const e = r.entry;
      const singleton = e.singleton ? " $(pinned) `[S]` singleton" : "";
      md.appendMarkdown(`**${escapeMd(e.name)}**${singleton}\n\n`);
      // Drift: the registry must not lie about the code (port invariant 2).
      if (r.exportName !== null && r.exportName !== e.name) {
        md.appendMarkdown(
          `$(warning) **header drifts from export** — \`@cairn ${escapeMd(e.name)}\` ≠ exported \`${escapeMd(r.exportName)}\`. Rename the export or fix the header.\n\n`,
        );
      } else {
        md.appendMarkdown("$(check) registry entry\n\n");
      }
      if (e.category.length > 0) {
        md.appendMarkdown(`Category: \`${escapeMd(e.category)}\`\n\n`);
      }
      if (e.purpose.length > 0) {
        md.appendMarkdown(`${escapeMd(e.purpose)}\n\n`);
      }
      if (e.aliases.length > 0) {
        md.appendMarkdown(`Aliases: ${e.aliases.map((a) => `\`${escapeMd(a)}\``).join(", ")}\n\n`);
      }
      if (e.singleton) {
        md.appendMarkdown(
          "$(pinned) Singleton — exists exactly once by project decision. Extend in place; never fork or rebuild.\n\n",
        );
      }
      md.appendMarkdown(
        `[Open component index](${vscode.Uri.file(this.resolver.componentsIndexFilePath()).toString()})`,
      );
    }
    return new vscode.Hover(md, token.range);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[`*_~[\]<>]/g, (c) => `\\${c}`);
}
