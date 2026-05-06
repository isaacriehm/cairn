/**
 * Citation CodeLens provider — renders the resolved title on a virtual
 * line BELOW each §DEC / §INV token when `cairn.lens.inlineMode === "below"`.
 *
 * Mechanism: VS Code's `CodeLens` always renders ABOVE the line indicated
 * by its `range.start.line`. To get the appearance of "below line N", the
 * lens is anchored at `line N + 1`. Multiple citations on the same line
 * stack into multiple CodeLens rows above line N+1, which the operator
 * reads as a multi-line annotation directly under the citation.
 *
 * Returns no lenses when the active mode is anything other than `below`,
 * so all four modes (`ghost` / `replace` / `below` / `off`) coexist with
 * a single registered provider.
 */

import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";

const DECISION_TOKEN_RE = /§(DEC-[0-9a-f]{7,})\b/g;
const INVARIANT_TOKEN_RE = /§(INV-[0-9a-f]{7,})\b/g;

type InlineMode = "ghost" | "replace" | "below" | "off";

function readInlineMode(): InlineMode {
  const raw = vscode.workspace
    .getConfiguration("cairn")
    .get<string>("lens.inlineMode");
  if (raw === "replace" || raw === "below" || raw === "off") return raw;
  return "ghost";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export class CitationCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires on config change so VS Code re-queries `provideCodeLenses`. */
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.emitter.event;

  constructor(private readonly resolver: LensResolver) {}

  /** External signal that the mode (or ledger) changed. */
  fire(): void {
    this.emitter.fire();
  }

  provideCodeLenses(
    doc: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (readInlineMode() !== "below") return [];
    if (doc.uri.scheme !== "file") return [];

    const lenses: vscode.CodeLens[] = [];
    const lineCount = Math.min(doc.lineCount, 5_000);
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      if (token.isCancellationRequested) break;
      const lineText = doc.lineAt(lineIdx).text;

      // Anchor lens at line+1 so it renders ABOVE line+1 = visually BELOW
      // the citation line. When the citation is on the last line, anchor
      // at the same line so the lens still appears (just above instead of
      // below — acceptable edge-case behaviour).
      const anchorLine = lineIdx + 1 < lineCount ? lineIdx + 1 : lineIdx;
      const anchor = new vscode.Range(anchorLine, 0, anchorLine, 0);

      // Lens labels intentionally OMIT the §<id> — the source citation is
      // already visible directly above the lens row, so repeating the id
      // is operator-noise. When two citations stack on the same line, the
      // lens order matches token order so the operator can pair them by
      // position alone.
      for (const m of lineText.matchAll(DECISION_TOKEN_RE)) {
        const id = m[1] as string;
        const r = this.resolver.resolveDecision(id);
        const title =
          r.status === "accepted"
            ? truncate(r.title, 100)
            : `(unresolved §${id})`;
        const glyph = r.status === "accepted" ? "✓" : "?";
        lenses.push(
          new vscode.CodeLens(anchor, {
            title: `↳ ${glyph} ${title}`,
            command: "cairn-lens.openDecisionsLedger",
          }),
        );
      }

      for (const m of lineText.matchAll(INVARIANT_TOKEN_RE)) {
        const id = m[1] as string;
        const r = this.resolver.resolveInvariant(id);
        let label: string;
        if (r.status === "active") {
          label = `✓ ${truncate(r.title, 100)}`;
        } else if (r.status === "superseded") {
          label = `⚠ superseded by §${r.supersededBy ?? "?"}`;
        } else {
          label = `(unresolved §${id})`;
        }
        lenses.push(
          new vscode.CodeLens(anchor, {
            title: `↳ ${label}`,
            command: "cairn-lens.openInvariantsLedger",
          }),
        );
      }
    }
    return lenses;
  }
}
