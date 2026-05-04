/**
 * Hover provider for harness citation tokens.
 *
 * Triggers on §V<N> and TODO(TSK-<id>) tokens. Renders a Markdown card with
 * resolved title, status, and links to the underlying ground file.
 */

import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";

const INVARIANT_TOKEN_RE = /§V\d+/g;
const TASK_TOKEN_RE = /TODO\(TSK-[A-Za-z0-9_-]+\)/g;

interface TokenMatch {
  kind: "invariant" | "task";
  id: string; // "V0023" or "TSK-foo"
  range: vscode.Range;
}

function findTokenAt(
  doc: vscode.TextDocument,
  position: vscode.Position,
): TokenMatch | null {
  const line = doc.lineAt(position.line).text;

  for (const m of line.matchAll(INVARIANT_TOKEN_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        kind: "invariant",
        id: m[0].slice(1), // strip leading §
        range: new vscode.Range(position.line, start, position.line, end),
      };
    }
  }
  for (const m of line.matchAll(TASK_TOKEN_RE)) {
    const start = m.index ?? -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    if (position.character >= start && position.character <= end) {
      // Inner: TODO(TSK-foo) → "TSK-foo"
      const inner = m[0].slice(5, -1);
      return {
        kind: "task",
        id: inner,
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
    if (token === null) return null;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;

    if (token.kind === "invariant") {
      const r = this.resolver.resolveInvariant(token.id);
      const statusLabel =
        r.status === "active"
          ? "$(check) active"
          : r.status === "superseded"
            ? `$(warning) superseded by §${r.supersededBy ?? "?"}`
            : "$(question) not in ledger";
      md.appendMarkdown(`**§${r.id}** — ${escapeMd(r.title)}\n\n`);
      md.appendMarkdown(`${statusLabel}\n\n`);
      if (r.sourceDecision !== null) {
        md.appendMarkdown(`Source decision: \`${r.sourceDecision}\`\n\n`);
      }
      md.appendMarkdown(
        `[Open invariants ledger](${vscode.Uri.file(this.resolver.invariantsLedgerFilePath()).toString()})`,
      );
    } else {
      const r = this.resolver.resolveTask(token.id);
      const stateLabel =
        r.found === "active"
          ? "$(circle-large-filled) active"
          : r.found === "done"
            ? "$(check-all) done — this TODO can be removed"
            : "$(circle-slash) not in tasks/{active,done}/";
      md.appendMarkdown(`**${r.id}** — ${escapeMd(r.title ?? "(no title)")}\n\n`);
      md.appendMarkdown(`${stateLabel}\n`);
    }
    return new vscode.Hover(md, token.range);
  }
}

function escapeMd(s: string): string {
  return s.replace(/[`*_~[\]<>]/g, (c) => `\\${c}`);
}
