/**
 * Cairn Lens — VS Code extension entry point.
 *
 * Wires up:
 *   - Hover provider for §DEC-NNNN, §V / TSK tokens
 *   - Decoration provider (inlay-style ghost text + gutter icons)
 *   - Code Lens provider (decisions in scope above functions)
 *   - DEC Explorer tree view (optional, behind config flag)
 *
 * Spec: docs/LENS_SPEC.md.
 */

import * as vscode from "vscode";
import { DecExplorerProvider } from "./panel/dec-explorer.js";
import { CitationDecorationManager } from "./providers/decoration-provider.js";
import { CitationHoverProvider } from "./providers/hover-provider.js";
import { ScopeCodeLensProvider } from "./providers/lens-provider.js";
import { LensResolver } from "./resolver.js";

const SOURCE_LANG_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
];

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("cairn");
  if (config.get<boolean>("lens.enabled") !== true) {
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) return;

  const repoRoot = LensResolver.resolveRepoRoot(folder.uri.fsPath);
  if (repoRoot === null) {
    // Not a cairn-adopted workspace; the extension stays inert.
    return;
  }
  const resolver = new LensResolver(repoRoot);

  // Hover provider
  const hoverProvider = new CitationHoverProvider(resolver);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SOURCE_LANG_SELECTOR, hoverProvider),
  );

  // Decorations (inlay text + gutter icons)
  const decorations = new CitationDecorationManager(resolver, context);
  context.subscriptions.push(decorations);

  // Code Lens (decisions in scope above functions)
  const lensProvider = new ScopeCodeLensProvider(resolver);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(SOURCE_LANG_SELECTOR, lensProvider),
  );

  // DEC Explorer sidebar
  //
  // Register unconditionally so VS Code always has a provider for the
  // "cairnLens.decExplorer" view id declared in package.json contributes.views.
  // The view panel itself is hidden/shown via the `when` clause in package.json.
  // If the view is visible but no provider is registered VS Code throws
  // "There is no data provider registered that can provide view data."
  const explorer = new DecExplorerProvider(resolver);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "cairnLens.decExplorer",
      explorer,
    ),
  );
  // Refresh the tree whenever the active editor changes.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => explorer.refresh()),
  );

  // File watchers — ledgers + scope-index drive cache invalidation.
  // The cairn-core ledger-cache module already keys on mtime, so the only
  // visible-side concern is forcing the editor's decoration / lens views to
  // re-render. The cheapest signal is `onDidChangeTextDocument` plus a
  // workspace file watcher fire on the ledger files.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      folder,
      ".cairn/ground/{invariants/invariants.ledger.yaml,decisions/decisions.ledger.yaml,scope-index.yaml}",
    ),
  );
  const onLedgerChange = (): void => {
    decorations.refreshAllVisible();
    lensProvider.fire();
    explorer.refresh();
  };
  context.subscriptions.push(
    watcher.onDidChange(onLedgerChange),
    watcher.onDidCreate(onLedgerChange),
    watcher.onDidDelete(onLedgerChange),
    watcher,
  );

  // Refresh decorations on visible-editor changes (initial render, focus).
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() =>
      decorations.refreshAllVisible(),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      decorations.refreshDocument(event.document);
    }),
  );
  decorations.refreshAllVisible();
}

export function deactivate(): void {
  // No global state to clear — context.subscriptions handles disposables.
}
