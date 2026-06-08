/**
 * Decoration manager — inlay-style ghost text after §INV / §DEC tokens plus a
 * left-gutter health icon column.
 *
 * Per LENS_SPEC §2.2 + §2.3:
 *   §INV-<hash> tokens:
 *     - Active invariant   -> checkmark + title  (muted green) + filled circle gutter
 *     - Superseded         -> warning + superseded by §INV-<hash> (muted yellow) + half-circle
 *     - Not in ledger      -> ? not in ledger    (muted red)   + empty circle
 *
 *   §DEC-<hash> tokens (new format emitted by strip-replace):
 *     - Accepted decision  -> checkmark + title  (muted blue)
 *     - Not in ledger      -> (unresolved)        (muted red)
 *
 * cairn.lens.inlineMode controls how resolved titles appear:
 *   "ghost"   — ghost text appended after the token (default)
 *   "replace" — the comment line containing the citation goes opacity:0
 *               and the resolved title is rendered as a `before` pseudo
 *               at the comment's start column. Source disappears, title
 *               takes its place.
 *   "below"   — handled by CitationCodeLensProvider (separate file). This
 *               manager skips inline after-decoration in below mode so
 *               there is no double-render with the lens.
 *   "off"     — inline display disabled
 *
 * VS Code does NOT render `\n` in `after.contentText` — long-standing
 * limitation tracked at microsoft/vscode#63600. The `display:block` /
 * `white-space:pre` CSS-inject via `textDecoration` is sanitized in
 * recent VS Code / Cursor builds. `below` therefore relies on a
 * separate CodeLensProvider anchored at line+1 to render the title on
 * a virtual line — see `citation-lens-provider.ts`.
 */

import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";
import { lensLog } from "../debug-log.js";
import { readPendingStalenessIds } from "../staleness.js";

type InlineMode = "ghost" | "replace" | "below" | "off";

// §DEC-<hash7> — content-addressed bare-token format from strip-replace.
const DECISION_TOKEN_RE = /§(DEC-[0-9a-f]{7,})\b/g;
const INVARIANT_TOKEN_RE = /§(INV-[0-9a-f]{7,})\b/g;

interface DecorationKit {
  inlineActive: vscode.TextEditorDecorationType;
  inlineSuperseded: vscode.TextEditorDecorationType;
  inlineUnknown: vscode.TextEditorDecorationType;
  gutterActive: vscode.TextEditorDecorationType;
  gutterSuperseded: vscode.TextEditorDecorationType;
  gutterUnknown: vscode.TextEditorDecorationType;
  /**
   * Layer-A staleness flag — `⚑` rendered in the left gutter alongside
   * the existing health icon when the cite's id is referenced by a
   * pending entry in `.cairn/staleness/log.jsonl`. Plan §10.4.
   */
  gutterStaleness: vscode.TextEditorDecorationType;
  inlineDecAccepted: vscode.TextEditorDecorationType;
  inlineDecUnknown: vscode.TextEditorDecorationType;
  /**
   * Replace mode: hides the source comment text by setting opacity:0 on
   * `[commentStart..lineEnd]` of every line containing a citation. The
   * sibling `replaceTitle*` decoration types prepend the resolved title
   * via per-decoration `before.contentText` so the line visually shows
   * ONLY the title.
   */
  replaceHider: vscode.TextEditorDecorationType;
  replaceTitleActive: vscode.TextEditorDecorationType;
  replaceTitleSuperseded: vscode.TextEditorDecorationType;
  replaceTitleUnknown: vscode.TextEditorDecorationType;
  replaceTitleDecAccepted: vscode.TextEditorDecorationType;
  replaceTitleDecUnknown: vscode.TextEditorDecorationType;
}

function afterOptions(
  color: string,
): vscode.ThemableDecorationAttachmentRenderOptions {
  return { color, margin: "0 0 0 0.5em" };
}

function makeKit(): DecorationKit {
  const inlineCommon = (color: string): vscode.DecorationRenderOptions => ({
    after: afterOptions(color),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const gutterCommon = (
    glyph: string,
  ): vscode.DecorationRenderOptions => ({
    before: { contentText: glyph, margin: "0 0.4em 0 0" },
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });
  const replaceHider = vscode.window.createTextEditorDecorationType({
    opacity: "0",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  // The replaceTitle types carry no static `before` block — each per-line
  // DecorationOptions provides its own `before.contentText` because the
  // resolved title differs per citation. The colour goes here so the
  // type's class is consistent across editor instances.
  const replaceTitle = (color: string): vscode.DecorationRenderOptions => ({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: { color, fontWeight: "600" },
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
    gutterStaleness: vscode.window.createTextEditorDecorationType({
      // Muted amber so the flag pops without looking like an error.
      before: { contentText: "⚑", color: "#ddb967", margin: "0 0.4em 0 0" },
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    }),
    inlineDecAccepted: vscode.window.createTextEditorDecorationType(
      inlineCommon("#7aa2d4"),
    ),
    inlineDecUnknown: vscode.window.createTextEditorDecorationType(
      inlineCommon("#e26d6d"),
    ),
    replaceHider,
    replaceTitleActive: vscode.window.createTextEditorDecorationType(
      replaceTitle("#7ec699"),
    ),
    replaceTitleSuperseded: vscode.window.createTextEditorDecorationType(
      replaceTitle("#ddb967"),
    ),
    replaceTitleUnknown: vscode.window.createTextEditorDecorationType(
      replaceTitle("#e26d6d"),
    ),
    replaceTitleDecAccepted: vscode.window.createTextEditorDecorationType(
      replaceTitle("#7aa2d4"),
    ),
    replaceTitleDecUnknown: vscode.window.createTextEditorDecorationType(
      replaceTitle("#e26d6d"),
    ),
  };
}

/**
 * Find the column where the comment BODY starts — i.e. the position right
 * after the opener (`//`, `#`, `/*`, `*`) and any trailing whitespace.
 * Returns null when no opener is found, so the replace path skips lines
 * that aren't recognisably comment-style.
 *
 * Keeping the opener visible (e.g. `  // ✓ <title>`) preserves the visual
 * cue that this line is a comment — operator feedback: with the opener
 * hidden too, the rendered title looked like raw code at column 0.
 */
function findCommentBodyStart(lineText: string, tokenStart: number): number | null {
  const upToToken = lineText.slice(0, tokenStart);
  const m = upToToken.match(/(?:\/\/|#|\/\*|\*)\s*$/);
  if (m) return upToToken.length;
  return null;
}

function workspaceFolderFor(docPath: string): string | null {
  const folder = vscode.workspace.workspaceFolders?.find((f) =>
    docPath.startsWith(`${f.uri.fsPath}/`) || docPath === f.uri.fsPath,
  );
  return folder?.uri.fsPath ?? null;
}

export class CitationDecorationManager implements vscode.Disposable {
  private kit: DecorationKit;
  private activeMode: InlineMode;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly resolver: LensResolver,
    _context: vscode.ExtensionContext,
  ) {
    this.activeMode = readInlineMode();
    this.kit = makeKit();
  }

  dispose(): void {
    for (const sub of this.subs) sub.dispose();
    for (const v of Object.values(this.kit)) v.dispose();
  }

  /** Re-read mode on every refresh. Decoration types are mode-agnostic. */
  private syncMode(): void {
    const newMode = readInlineMode();
    if (newMode === this.activeMode) return;
    lensLog(`inlineMode changed: ${this.activeMode} → ${newMode}`);
    this.activeMode = newMode;
  }

  refreshAllVisible(): void {
    this.syncMode();
    const editors = vscode.window.visibleTextEditors;
    lensLog(`refreshAllVisible: ${editors.length} editor(s) visible`);
    for (const editor of editors) {
      this.refreshEditor(editor);
    }
  }

  refreshDocument(doc: vscode.TextDocument): void {
    this.syncMode();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) this.refreshEditor(editor);
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    const config = vscode.workspace.getConfiguration("cairn");
    const inlineEnabled = config.get<boolean>("lens.inlineDecorations") === true;
    const gutterEnabled = config.get<boolean>("lens.gutterIcons") === true;
    const mode = this.activeMode;

    const inlineActive: vscode.DecorationOptions[] = [];
    const inlineSuperseded: vscode.DecorationOptions[] = [];
    const inlineUnknown: vscode.DecorationOptions[] = [];
    const gutterActive: vscode.Range[] = [];
    const gutterSuperseded: vscode.Range[] = [];
    const gutterUnknown: vscode.Range[] = [];
    const gutterStaleness: vscode.Range[] = [];
    const inlineDecAccepted: vscode.DecorationOptions[] = [];
    const inlineDecUnknown: vscode.DecorationOptions[] = [];
    const replaceHiderRanges: vscode.Range[] = [];
    const replaceTitleActive: vscode.DecorationOptions[] = [];
    const replaceTitleSuperseded: vscode.DecorationOptions[] = [];
    const replaceTitleUnknown: vscode.DecorationOptions[] = [];
    const replaceTitleDecAccepted: vscode.DecorationOptions[] = [];
    const replaceTitleDecUnknown: vscode.DecorationOptions[] = [];

    const doc = editor.document;
    if (!shouldDecorate(doc)) {
      lensLog(
        `refreshEditor ${doc.uri.fsPath} — shouldDecorate=false (scheme=${doc.uri.scheme}, language=${doc.languageId}); clearing`,
      );
      this.applyEmpty(editor);
      return;
    }

    lensLog(
      `refreshEditor ${doc.uri.fsPath} — mode=${mode}, scanning ${Math.min(doc.lineCount, 5_000)} lines`,
    );

    interface TokenHit {
      lineIdx: number;
      start: number;
      end: number;
      id: string;
    }
    const decHits: TokenHit[] = [];
    const invHits: TokenHit[] = [];

    const lineCount = Math.min(doc.lineCount, 5_000);
    for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
      const lineText = doc.lineAt(lineIdx).text;
      for (const m of lineText.matchAll(DECISION_TOKEN_RE)) {
        const start = m.index ?? -1;
        if (start < 0) continue;
        decHits.push({ lineIdx, start, end: start + m[0].length, id: m[1] as string });
      }
      for (const m of lineText.matchAll(INVARIANT_TOKEN_RE)) {
        const start = m.index ?? -1;
        if (start < 0) continue;
        invHits.push({ lineIdx, start, end: start + m[0].length, id: m[1] as string });
      }
    }

    const decCache = new Map(
      [...new Set(decHits.map((h) => h.id))].map((id) => [
        id,
        this.resolver.resolveDecision(id),
      ]),
    );
    const invCache = new Map(
      [...new Set(invHits.map((h) => h.id))].map((id) => [
        id,
        this.resolver.resolveInvariant(id),
      ]),
    );
    // Pending staleness — gutter `⚑` next to any token whose id is
    // mentioned by a drift event in `.cairn/staleness/log.jsonl`.
    const folder = workspaceFolderFor(doc.uri.fsPath);
    const pendingStaleIds = folder === null ? new Set<string>() : readPendingStalenessIds(folder);
    const flaggedLines = new Set<number>();
    const flagIfPending = (lineIdx: number, start: number, end: number, id: string): void => {
      if (!gutterEnabled) return;
      if (!pendingStaleIds.has(id)) return;
      if (flaggedLines.has(lineIdx)) return;
      gutterStaleness.push(new vscode.Range(lineIdx, start, lineIdx, end));
      flaggedLines.add(lineIdx);
    };

    // Collect one hider range per CITATION-LINE (deduped) so multiple
    // tokens on the same line don't emit redundant ranges. The hider
    // covers `[bodyStart..lineEnd]` — the comment opener (`// `, `# `,
    // ` * `) stays visible so the operator can see this line was a
    // comment. Returns the title-anchor range (1-char wide at bodyStart)
    // for the per-decoration `before.contentText` placement.
    const hiderLinesEmitted = new Set<number>();
    const collectReplaceHider = (lineIdx: number, tokenStart: number): vscode.Range | null => {
      if (mode !== "replace") return null;
      if (hiderLinesEmitted.has(lineIdx)) return null;
      const lineText = doc.lineAt(lineIdx).text;
      const bodyStart = findCommentBodyStart(lineText, tokenStart);
      if (bodyStart === null) return null;
      const lineEndCol = lineText.length;
      if (bodyStart >= lineEndCol) return null;
      const hider = new vscode.Range(lineIdx, bodyStart, lineIdx, lineEndCol);
      replaceHiderRanges.push(hider);
      hiderLinesEmitted.add(lineIdx);
      return new vscode.Range(lineIdx, bodyStart, lineIdx, bodyStart + 1);
    };

    const shouldRenderGhost = inlineEnabled && (mode === "ghost");
    const shouldRenderReplace = inlineEnabled && mode === "replace";
    // "below" + "off" skip after-decoration entirely — below renders via
    // the citation CodeLens provider; off means inline display disabled.

    // VS Code limitation (microsoft/vscode#63600): `after.contentText`
    // cannot render `\n` and is sanitized against CSS-injection of block
    // layout. So inline ghost text is always single-line. To stop the
    // operator from losing context when titles are long or multi-line,
    // every inline / replace decoration gets a `hoverMessage` carrying
    // the full untruncated title — hover reveals what the inline view
    // had to clip.
    const buildHover = (id: string, fullTitle: string, status: string): vscode.MarkdownString => {
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = false;
      md.supportHtml = false;
      md.appendMarkdown(`**§${id}** _(${status})_\n\n${fullTitle}`);
      return md;
    };

    for (const { lineIdx, start, end, id } of decHits) {
      const r = decCache.get(id)!;
      const range = new vscode.Range(lineIdx, start, lineIdx, end);
      flagIfPending(lineIdx, start, end, id);
      const hover = buildHover(id, r.title, r.status);
      if (shouldRenderGhost) {
        const trailer =
          r.status === "accepted"
            ? `✓ ${truncate(r.title, 60)}`
            : "(unresolved)";
        const opt: vscode.DecorationOptions = {
          range,
          hoverMessage: hover,
          renderOptions: { after: { contentText: trailer } },
        };
        if (r.status === "accepted") inlineDecAccepted.push(opt);
        else inlineDecUnknown.push(opt);
      } else if (shouldRenderReplace) {
        const titleAnchor = collectReplaceHider(lineIdx, start);
        if (titleAnchor !== null) {
          const trailer =
            r.status === "accepted"
              ? `✓ ${truncate(r.title, 100)}`
              : `? (unresolved §${id})`;
          const opt: vscode.DecorationOptions = {
            range: titleAnchor,
            hoverMessage: hover,
            renderOptions: { before: { contentText: trailer } },
          };
          if (r.status === "accepted") replaceTitleDecAccepted.push(opt);
          else replaceTitleDecUnknown.push(opt);
        }
      }
    }

    for (const { lineIdx, start, end, id } of invHits) {
      const r = invCache.get(id)!;
      const range = new vscode.Range(lineIdx, start, lineIdx, end);
      flagIfPending(lineIdx, start, end, id);
      const hover = buildHover(
        id,
        r.title,
        r.status === "superseded" && r.supersededBy
          ? `superseded by §${r.supersededBy}`
          : r.status,
      );
      if (shouldRenderGhost) {
        const trailer =
          r.status === "active"
            ? `✓ ${truncate(r.title, 60)}`
            : r.status === "superseded"
              ? `⚠ superseded by §${r.supersededBy ?? "?"}`
              : "(unresolved)";
        const opt: vscode.DecorationOptions = {
          range,
          hoverMessage: hover,
          renderOptions: { after: { contentText: trailer } },
        };
        if (r.status === "active") inlineActive.push(opt);
        else if (r.status === "superseded") inlineSuperseded.push(opt);
        else inlineUnknown.push(opt);
      } else if (shouldRenderReplace) {
        const titleAnchor = collectReplaceHider(lineIdx, start);
        if (titleAnchor !== null) {
          const trailer =
            r.status === "active"
              ? `✓ ${truncate(r.title, 100)}`
              : r.status === "superseded"
                ? `⚠ superseded by §${r.supersededBy ?? "?"}`
                : `? (unresolved §${id})`;
          const opt: vscode.DecorationOptions = {
            range: titleAnchor,
            hoverMessage: hover,
            renderOptions: { before: { contentText: trailer } },
          };
          if (r.status === "active") replaceTitleActive.push(opt);
          else if (r.status === "superseded") replaceTitleSuperseded.push(opt);
          else replaceTitleUnknown.push(opt);
        }
      }
      if (gutterEnabled) {
        if (r.status === "active") gutterActive.push(range);
        else if (r.status === "superseded") gutterSuperseded.push(range);
        else gutterUnknown.push(range);
      }
    }

    editor.setDecorations(this.kit.inlineActive, inlineActive);
    editor.setDecorations(this.kit.inlineSuperseded, inlineSuperseded);
    editor.setDecorations(this.kit.inlineUnknown, inlineUnknown);
    editor.setDecorations(this.kit.gutterActive, gutterActive);
    editor.setDecorations(this.kit.gutterSuperseded, gutterSuperseded);
    editor.setDecorations(this.kit.gutterUnknown, gutterUnknown);
    editor.setDecorations(this.kit.gutterStaleness, gutterStaleness);
    editor.setDecorations(this.kit.inlineDecAccepted, inlineDecAccepted);
    editor.setDecorations(this.kit.inlineDecUnknown, inlineDecUnknown);
    editor.setDecorations(this.kit.replaceHider, replaceHiderRanges);
    editor.setDecorations(this.kit.replaceTitleActive, replaceTitleActive);
    editor.setDecorations(this.kit.replaceTitleSuperseded, replaceTitleSuperseded);
    editor.setDecorations(this.kit.replaceTitleUnknown, replaceTitleUnknown);
    editor.setDecorations(this.kit.replaceTitleDecAccepted, replaceTitleDecAccepted);
    editor.setDecorations(this.kit.replaceTitleDecUnknown, replaceTitleDecUnknown);
    lensLog(
      `refreshEditor ${doc.uri.fsPath} — applied DEC(${inlineDecAccepted.length}+${inlineDecUnknown.length}) V(${inlineActive.length}+${inlineSuperseded.length}+${inlineUnknown.length}) hider(${replaceHiderRanges.length}) gutter(${gutterActive.length}+${gutterSuperseded.length}+${gutterUnknown.length}) stale(${gutterStaleness.length})`,
    );
  }

  private applyEmpty(editor: vscode.TextEditor): void {
    editor.setDecorations(this.kit.inlineActive, []);
    editor.setDecorations(this.kit.inlineSuperseded, []);
    editor.setDecorations(this.kit.inlineUnknown, []);
    editor.setDecorations(this.kit.gutterActive, []);
    editor.setDecorations(this.kit.gutterSuperseded, []);
    editor.setDecorations(this.kit.gutterUnknown, []);
    editor.setDecorations(this.kit.gutterStaleness, []);
    editor.setDecorations(this.kit.inlineDecAccepted, []);
    editor.setDecorations(this.kit.inlineDecUnknown, []);
    editor.setDecorations(this.kit.replaceHider, []);
    editor.setDecorations(this.kit.replaceTitleActive, []);
    editor.setDecorations(this.kit.replaceTitleSuperseded, []);
    editor.setDecorations(this.kit.replaceTitleUnknown, []);
    editor.setDecorations(this.kit.replaceTitleDecAccepted, []);
    editor.setDecorations(this.kit.replaceTitleDecUnknown, []);
  }
}

function readInlineMode(): InlineMode {
  const raw = vscode.workspace
    .getConfiguration("cairn")
    .get<string>("lens.inlineMode");
  if (raw === "replace" || raw === "below" || raw === "off") return raw;
  return "ghost";
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
