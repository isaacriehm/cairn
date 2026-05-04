/**
 * Code Lens provider — renders one decision/invariants summary above the
 * topmost function in a file when the file is in scope per the scope-index.
 *
 * Per LENS_SPEC §2.4. Heuristic-only: we anchor the lens at the first line
 * that looks like a function-ish declaration (regex), or at line 0 when no
 * candidate is found in the visible viewport.
 */

import { relative } from "node:path";
import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";

const FN_LIKE_RE =
  /^(?:export\s+)?(?:async\s+)?(?:function|const\s+\w+\s*=\s*(?:async\s*)?\(?|class\s+\w+|def\s+\w+|fn\s+\w+|func\s+\w+)/;

export class ScopeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.emitter.event;

  constructor(private readonly resolver: LensResolver) {}

  fire(): void {
    this.emitter.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration("harness");
    if (config.get<boolean>("lens.codeLens") !== true) return [];
    if (document.uri.scheme !== "file") return [];

    const relPath = relative(this.resolver.repoRoot, document.uri.fsPath).replace(
      /\\/g,
      "/",
    );
    if (relPath.startsWith("..")) return [];

    const scope = this.resolver.resolveScopeWithTitles(relPath);
    if (scope === null) return [];
    if (scope.unscoped) return [];
    if (scope.decisions.length === 0 && scope.invariants.length === 0) return [];

    const anchorLine = findAnchorLine(document);
    const range = new vscode.Range(anchorLine, 0, anchorLine, 0);
    const decCount = scope.decisions.length;
    const invCount = scope.invariants.length;
    const title =
      `⬡ ${decCount} decision${decCount === 1 ? "" : "s"} in scope` +
      ` · ${invCount} invariant${invCount === 1 ? "" : "s"}` +
      ` · View all`;
    const lens = new vscode.CodeLens(range, {
      title,
      command: "vscode.open",
      arguments: [
        vscode.Uri.file(this.resolver.decisionsLedgerFilePath()),
      ],
    });
    return [lens];
  }
}

function findAnchorLine(doc: vscode.TextDocument): number {
  const max = Math.min(doc.lineCount, 200);
  for (let i = 0; i < max; i++) {
    if (FN_LIKE_RE.test(doc.lineAt(i).text)) return i;
  }
  return 0;
}
