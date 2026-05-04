/**
 * DEC Explorer — sidebar tree view (LENS_SPEC §2.5).
 *
 * Two top-level groups for the active editor's file:
 *   ◢ Decisions in scope     (id, title; click → open decisions ledger)
 *   ◢ Invariants in scope    (id, title; click → open invariants ledger)
 *
 * Empty when the active file has no scope-index entry, when the workspace is
 * not harness-adopted, or when the index is unscoped for this file.
 */

import { relative } from "node:path";
import * as vscode from "vscode";
import { LensResolver } from "../resolver.js";

type Node =
  | { kind: "group"; label: string; entries: ScopeEntry[] }
  | { kind: "entry"; entry: ScopeEntry; group: "decisions" | "invariants" };

interface ScopeEntry {
  id: string;
  title: string;
}

export class DecExplorerProvider
  implements vscode.TreeDataProvider<Node>
{
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData: vscode.Event<Node | undefined> =
    this.emitter.event;

  constructor(private readonly resolver: LensResolver) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        `${node.label} (${node.entries.length})`,
        node.entries.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      return item;
    }
    const label = `${node.entry.id}  —  ${node.entry.title}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      node.group === "decisions" ? "law" : "shield",
    );
    item.command = {
      title: "Open ledger",
      command: "vscode.open",
      arguments: [
        vscode.Uri.file(
          node.group === "decisions"
            ? this.resolver.decisionsLedgerFilePath()
            : this.resolver.invariantsLedgerFilePath(),
        ),
      ],
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (element !== undefined) {
      if (element.kind !== "group") return [];
      return element.entries.map(
        (entry): Node => ({
          kind: "entry",
          entry,
          group: element.label.startsWith("Decisions") ? "decisions" : "invariants",
        }),
      );
    }

    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) return [];
    if (editor.document.uri.scheme !== "file") return [];

    const relPath = relative(
      this.resolver.repoRoot,
      editor.document.uri.fsPath,
    ).replace(/\\/g, "/");
    if (relPath.startsWith("..")) return [];

    const scope = this.resolver.resolveScopeWithTitles(relPath);
    if (scope === null) return [];
    if (scope.unscoped) return [];

    return [
      { kind: "group", label: "Decisions in scope", entries: scope.decisions },
      {
        kind: "group",
        label: "Invariants in scope",
        entries: scope.invariants,
      },
    ];
  }
}
