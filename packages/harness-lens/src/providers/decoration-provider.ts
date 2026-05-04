/**
 * Decoration manager — inlay-style ghost text after §V tokens + a left-gutter
 * health icon column.
 *
 * Per LENS_SPEC §2.2 + §2.3:
 *   - Active invariant  → ✓ <title>   (muted green) + ● gutter
 *   - Superseded        → ⚠ superseded by §V<M>  (muted yellow) + ◐ gutter
 *   - Not in ledger     → ? not in ledger          (muted red)   + ○ gutter
 */

import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";

const INVARIANT_TOKEN_RE = /§V(\d+)/g;

interface DecorationKit {
  inlineActive: vscode.TextEditorDecorationType;
  inlineSuperseded: vscode.TextEditorDecorationType;
  inlineUnknown: vscode.TextEditorDecorationType;
  gutterActive: vscode.TextEditorDecorationType;
  gutterSuperseded: vscode.TextEditorDecorationType;
  gutterUnknown: vscode.TextEditorDecorationType;
}

function makeKit(): DecorationKit {
  const inlineCommon = (color: string): vscode.DecorationRenderOptions => ({
    after: { color, margin: "0 0 0 0.5em" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const gutterCommon = (
    glyph: string,
  ): vscode.DecorationRenderOptions => ({
    before: { contentText: glyph, margin: "0 0.4em 0 0" },
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });
  return {
    inlineActive: vscode.window.createTextEditorDecorationType(
      inlineCommon("#7ec699"),
    ),
    inlineSuperseded: vscode.window.createTextEditorDecorationType(
      inlineCommon("#ddb967"),
    ),
    inlineUnknown: vscode.window.createTextEditorDecorationType(
      inlineCommon("#e26d6d"),
    ),
    gutterActive: vscode.window.createTextEditorDecorationType(
      gutterCommon("●"),
    ),
    gutterSuperseded: vscode.window.createTextEditorDecorationType(
      gutterCommon("◐"),
    ),
    gutterUnknown: vscode.window.createTextEditorDecorationType(
      gutterCommon("○"),
    ),
  };
}

export class CitationDecorationManager implements vscode.Disposable {
  private readonly kit: DecorationKit;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly resolver: LensResolver,
    _context: vscode.ExtensionContext,
  ) {
    this.kit = makeKit();
  }

  dispose(): void {
    for (const sub of this.subs) sub.dispose();
    for (const v of Object.values(this.kit)) v.dispose();
  }

  refreshAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor);
    }
  }

  refreshDocument(doc: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) this.refreshEditor(editor);
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    const config = vscode.workspace.getConfiguration("harness");
    const inlineEnabled = config.get<boolean>("lens.inlineDecorations") === true;
    const gutterEnabled = config.get<boolean>("lens.gutterIcons") === true;

    const inlineActive: vscode.DecorationOptions[] = [];
    const inlineSuperseded: vscode.DecorationOptions[] = [];
    const inlineUnknown: vscode.DecorationOptions[] = [];
    const gutterActive: vscode.Range[] = [];
    const gutterSuperseded: vscode.Range[] = [];
    const gutterUnknown: vscode.Range[] = [];

    const doc = editor.document;
    if (!shouldDecorate(doc)) {
      this.applyEmpty(editor);
      return;
    }

    const lineCount = Math.min(doc.lineCount, 5_000);
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      const lineText = doc.lineAt(lineIdx).text;
      for (const m of lineText.matchAll(INVARIANT_TOKEN_RE)) {
        const start = m.index ?? -1;
        if (start < 0) continue;
        const end = start + m[0].length;
        const id = m[0].slice(1); // "V0023"
        const r = this.resolver.resolveInvariant(id);
        const range = new vscode.Range(lineIdx, start, lineIdx, end);

        if (inlineEnabled) {
          const trailerText =
            r.status === "active"
              ? `✓ ${truncate(r.title, 60)}`
              : r.status === "superseded"
                ? `⚠ superseded by §${r.supersededBy ?? "?"}`
                : "? not in ledger";
          const opt: vscode.DecorationOptions = {
            range,
            renderOptions: {
              after: { contentText: trailerText },
            },
          };
          if (r.status === "active") inlineActive.push(opt);
          else if (r.status === "superseded") inlineSuperseded.push(opt);
          else inlineUnknown.push(opt);
        }
        if (gutterEnabled) {
          if (r.status === "active") gutterActive.push(range);
          else if (r.status === "superseded") gutterSuperseded.push(range);
          else gutterUnknown.push(range);
        }
      }
    }

    editor.setDecorations(this.kit.inlineActive, inlineActive);
    editor.setDecorations(this.kit.inlineSuperseded, inlineSuperseded);
    editor.setDecorations(this.kit.inlineUnknown, inlineUnknown);
    editor.setDecorations(this.kit.gutterActive, gutterActive);
    editor.setDecorations(this.kit.gutterSuperseded, gutterSuperseded);
    editor.setDecorations(this.kit.gutterUnknown, gutterUnknown);
  }

  private applyEmpty(editor: vscode.TextEditor): void {
    editor.setDecorations(this.kit.inlineActive, []);
    editor.setDecorations(this.kit.inlineSuperseded, []);
    editor.setDecorations(this.kit.inlineUnknown, []);
    editor.setDecorations(this.kit.gutterActive, []);
    editor.setDecorations(this.kit.gutterSuperseded, []);
    editor.setDecorations(this.kit.gutterUnknown, []);
  }
}

function shouldDecorate(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  if (doc.lineCount > 5_000) return false;
  return true;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
