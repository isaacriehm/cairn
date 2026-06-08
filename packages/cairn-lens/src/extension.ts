/**
 * Cairn Lens — VS Code / Cursor extension entry point.
 *
 * Wires up:
 *   - LogOutputChannel ("Cairn Lens" in the Output dropdown)
 *   - Status-bar item (always visible after activate)
 *   - Palette commands: showLog, diagnose, refresh, openDecisionsLedger,
 *     openInvariantsLedger
 *   - Hover provider for §DEC-<hash>, §INV-<hash>, TSK-* tokens
 *   - Decoration manager (inlay ghost text + gutter health icons)
 *   - Code Lens provider (decisions in scope above functions)
 *   - DEC Explorer tree view (optional, behind config flag)
 *
 * Activation contract: even when the workspace has no `.cairn/`
 * directory, the extension still registers the showLog and diagnose
 * commands and shows an "inert" status-bar item, so the operator can
 * always see the activation trail and self-diagnose. New behaviour
 * never silently swallows the activation path.
 *
 * Spec: docs/LENS_SPEC.md.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { setStateLogger } from "@isaacriehm/cairn-state";
import { DecExplorerProvider } from "./panel/dec-explorer.js";
import { CitationCodeLensProvider } from "./providers/citation-lens-provider.js";
import { CitationDecorationManager } from "./providers/decoration-provider.js";
import { CitationHoverProvider } from "./providers/hover-provider.js";
import { ScopeCodeLensProvider } from "./providers/lens-provider.js";
import { LensResolver } from "./resolver.js";
import { scheduleUpdateCheck } from "./update-check.js";
import {
  attachLensLogChannel,
  lensLog,
  showLensLog,
  type LensLogChannel,
} from "./debug-log.js";

const SOURCE_LANG_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
];

interface LensRuntime {
  repoRoot: string;
  resolver: LensResolver;
  decorations: CitationDecorationManager;
  lensProvider: ScopeCodeLensProvider;
  citationLensProvider: CitationCodeLensProvider;
  explorer: DecExplorerProvider;
  watcherFired: boolean;
}

let runtime: LensRuntime | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Phase 1 — bulletproof surface. Output channel + status bar +
  // palette commands ALWAYS register, even when the workspace is
  // empty or .cairn/ is absent. If anything throws past this point
  // the operator can still hit "Cairn Lens: Show Debug Log" and
  // "Cairn Lens: Diagnose" to figure out why.
  const channel = vscode.window.createOutputChannel("Cairn Lens", {
    log: true,
  });
  context.subscriptions.push(channel);
  attachLensLogChannel(channel);

  // Initialize the state package logger to forward to our lensLog.
  setStateLogger({
    debug: (obj, msg) => lensLog(`${msg} ${JSON.stringify(obj)}`, "debug"),
    info: (obj, msg) => lensLog(`${msg} ${JSON.stringify(obj)}`, "info"),
    warn: (obj, msg) => lensLog(`${msg} ${JSON.stringify(obj)}`, "warn"),
    error: (obj, msg) => lensLog(`${msg} ${JSON.stringify(obj)}`, "error"),
  });

  const version = readExtensionVersion(context);
  lensLog(`activate() — Cairn Lens v${version}`);
  lensLog(
    `host: ${vscode.env.appName} ${vscode.version} (uriScheme=${vscode.env.uriScheme})`,
  );

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "cairn-lens.showLog";
  statusBar.text = "$(symbol-key) cairn-lens";
  statusBar.tooltip = "Cairn Lens — click to open debug log";
  statusBar.show();
  context.subscriptions.push(statusBar);
  lensLog("status-bar item shown (inert)");

  // Always-on palette commands. Registered before any early-return
  // so they never 404 in the Command Palette.
  context.subscriptions.push(
    vscode.commands.registerCommand("cairn-lens.showLog", () => {
      lensLog("command: cairn-lens.showLog");
      showLensLog();
    }),
    vscode.commands.registerCommand("cairn-lens.diagnose", () => {
      lensLog("command: cairn-lens.diagnose");
      runDiagnose(context, version);
      showLensLog();
    }),
  );

  // Phase 2 — best-effort wire-up of the resolver + providers. Any
  // failure here is logged and surfaced via showErrorMessage but the
  // commands above stay alive.
  try {
    activateProviders(context, statusBar);
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    lensLog(`activate() provider wire-up failed: ${message}`, "error");
    void vscode.window.showErrorMessage(
      `Cairn Lens: provider wire-up failed — ${message.split("\n")[0] ?? "(no message)"}. ` +
        "Run 'Cairn Lens: Show Debug Log' for details.",
    );
    statusBar.text = "$(error) cairn-lens";
    statusBar.tooltip = "Cairn Lens — activation error, click for log";
  }

  // Phase 3 — best-effort, non-blocking update check. Cairn Lens ships
  // as a .vsix (no Marketplace auto-update), so this is how the operator
  // learns a newer version exists. Throttled to once/day; silent on any
  // network failure.
  scheduleUpdateCheck(context, version);
}

function activateProviders(
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
): void {
  const config = vscode.workspace.getConfiguration("cairn");
  const enabled = config.get<boolean>("lens.enabled");
  lensLog(`config: cairn.lens.enabled = ${String(enabled)}`);
  if (enabled !== true) {
    lensLog("staying inert: cairn.lens.enabled !== true");
    statusBar.text = "$(circle-slash) cairn-lens";
    statusBar.tooltip = "Cairn Lens disabled (cairn.lens.enabled = false)";
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  lensLog(
    `workspace folders: ${
      folders === undefined
        ? "undefined"
        : folders.length === 0
          ? "empty"
          : folders.map((f) => f.uri.fsPath).join(", ")
    }`,
  );
  const folder = folders?.[0];
  if (folder === undefined) {
    lensLog("staying inert: no workspace folder open");
    statusBar.text = "$(circle-slash) cairn-lens";
    statusBar.tooltip = "Cairn Lens — no workspace folder open";
    return;
  }

  const repoRoot = LensResolver.resolveRepoRoot(folder.uri.fsPath);
  lensLog(`resolveRepoRoot(${folder.uri.fsPath}) → ${repoRoot ?? "null"}`);
  if (repoRoot === null) {
    lensLog("staying inert: no .cairn/ found — arming init watcher");
    statusBar.text = "$(circle-slash) cairn-lens";
    statusBar.tooltip =
      "Cairn Lens — no .cairn/ directory found (waiting for cairn init)";
    // Watch for .cairn/ creation after cairn init runs.
    const initWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".cairn/**"),
    );
    const onCairnAppear = (): void => {
      const newRoot = LensResolver.resolveRepoRoot(folder.uri.fsPath);
      if (newRoot === null) return;
      lensLog(`.cairn/ detected at ${newRoot} — wiring providers`);
      initWatcher.dispose();
      try {
        wireProviders(context, statusBar, folder, newRoot);
        void vscode.window.showInformationMessage("Cairn Lens: ready");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lensLog(`provider wire-up after init failed: ${msg}`, "error");
      }
    };
    context.subscriptions.push(
      initWatcher.onDidCreate(onCairnAppear),
      initWatcher.onDidChange(onCairnAppear),
      initWatcher,
    );
    return;
  }

  wireProviders(context, statusBar, folder, repoRoot);
  lensLog("activate() complete — initial decorations refreshed");
}

function wireProviders(
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem,
  folder: vscode.WorkspaceFolder,
  repoRoot: string,
): void {
  const resolver = new LensResolver(repoRoot);
  lensLog(`LensResolver constructed for repoRoot=${repoRoot}`);

  const hoverProvider = new CitationHoverProvider(resolver);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SOURCE_LANG_SELECTOR, hoverProvider),
  );
  lensLog("hover provider registered (selector: scheme=file)");

  const decorations = new CitationDecorationManager(resolver, context);
  context.subscriptions.push(decorations);
  lensLog("decoration manager registered");

  const lensProvider = new ScopeCodeLensProvider(resolver);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(SOURCE_LANG_SELECTOR, lensProvider),
  );
  lensLog("code-lens provider registered (scope summaries)");

  const citationLensProvider = new CitationCodeLensProvider(resolver);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      SOURCE_LANG_SELECTOR,
      citationLensProvider,
    ),
  );
  lensLog("code-lens provider registered (below-mode citation titles)");

  // DEC Explorer — register unconditionally so VS Code always has a
  // provider for the view id; the panel's visibility is gated by the
  // `when` clause in package.json.
  const explorer = new DecExplorerProvider(resolver);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("cairnLens.decExplorer", explorer),
  );
  lensLog("DEC explorer tree provider registered");

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      lensLog("onDidChangeActiveTextEditor → explorer.refresh()");
      explorer.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const matched =
        event.affectsConfiguration("cairn.lens.enabled") ||
        event.affectsConfiguration("cairn.lens.inlineDecorations") ||
        event.affectsConfiguration("cairn.lens.gutterIcons") ||
        event.affectsConfiguration("cairn.lens.codeLens") ||
        event.affectsConfiguration("cairn.lens.decExplorer") ||
        event.affectsConfiguration("cairn.lens.inlineMode");
      if (matched) {
        lensLog("config change affecting lens → refresh");
        decorations.refreshAllVisible();
        lensProvider.fire();
        citationLensProvider.fire();
        explorer.refresh();
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      folder,
      ".cairn/{ground/invariants/invariants.ledger.yaml,ground/decisions/decisions.ledger.yaml,ground/scope-index.yaml,staleness/log.jsonl}",
    ),
  );
  const onLedgerChange = (uri: vscode.Uri): void => {
    lensLog(`ledger change: ${uri.fsPath} → refresh`);
    if (runtime !== null) runtime.watcherFired = true;
    decorations.refreshAllVisible();
    lensProvider.fire();
    citationLensProvider.fire();
    explorer.refresh();
  };
  context.subscriptions.push(
    watcher.onDidChange(onLedgerChange),
    watcher.onDidCreate(onLedgerChange),
    watcher.onDidDelete(onLedgerChange),
    watcher,
  );
  lensLog("ledger file watcher armed (.cairn/ground/...)");

  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const REFRESH_DEBOUNCE_MS = 150;
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      lensLog("onDidChangeVisibleTextEditors → refreshAllVisible");
      decorations.refreshAllVisible();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      const key = event.document.uri.toString();
      const existing = refreshTimers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        refreshTimers.delete(key);
        lensLog(`debounced text change → refresh ${event.document.uri.fsPath}`);
        decorations.refreshDocument(event.document);
      }, REFRESH_DEBOUNCE_MS);
      refreshTimers.set(key, timer);
    }),
    {
      dispose(): void {
        for (const t of refreshTimers.values()) clearTimeout(t);
        refreshTimers.clear();
      },
    },
  );
  decorations.refreshAllVisible();

  statusBar.text = "$(symbol-key) cairn-lens";
  statusBar.tooltip = `Cairn Lens active — repo: ${repoRoot}\nClick to open debug log`;

  context.subscriptions.push(
    vscode.commands.registerCommand("cairn-lens.refresh", () => {
      lensLog("command: cairn-lens.refresh — manual refresh");
      decorations.refreshAllVisible();
      lensProvider.fire();
      citationLensProvider.fire();
      explorer.refresh();
    }),
    vscode.commands.registerCommand(
      "cairn-lens.openDecisionsLedger",
      async () => {
        const path = resolver.decisionsLedgerFilePath();
        lensLog(`command: openDecisionsLedger → ${path}`);
        const doc = await vscode.workspace.openTextDocument(path);
        await vscode.window.showTextDocument(doc);
      },
    ),
    vscode.commands.registerCommand(
      "cairn-lens.openInvariantsLedger",
      async () => {
        const path = resolver.invariantsLedgerFilePath();
        lensLog(`command: openInvariantsLedger → ${path}`);
        const doc = await vscode.workspace.openTextDocument(path);
        await vscode.window.showTextDocument(doc);
      },
    ),
  );

  runtime = {
    repoRoot,
    resolver,
    decorations,
    lensProvider,
    citationLensProvider,
    explorer,
    watcherFired: false,
  };
}

export function deactivate(): void {
  lensLog("deactivate() called");
  runtime = null;
}

function readExtensionVersion(context: vscode.ExtensionContext): string {
  try {
    const pkg = context.extension.packageJSON as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Self-diagnostic dump — operator's first stop when the extension
 * looks dead. Writes a structured report to the OutputChannel
 * covering host/version, workspace, repo root, ledger presence,
 * config values, editor population, and runtime wiring.
 */
function runDiagnose(
  context: vscode.ExtensionContext,
  version: string,
): void {
  lensLog("=== cairn-lens diagnose ===");
  lensLog(`extension version: ${version}`);
  lensLog(
    `host: ${vscode.env.appName} ${vscode.version} (machineId=${vscode.env.machineId.slice(0, 8)}…)`,
  );
  const pkg: unknown = context.extension.packageJSON;
  let vscodePin = "unknown";
  if (typeof pkg === "object" && pkg !== null && "engines" in pkg) {
    const engines: unknown = pkg.engines;
    if (typeof engines === "object" && engines !== null && "vscode" in engines && typeof engines.vscode === "string") {
      vscodePin = engines.vscode;
    }
  }
  lensLog(`engine pin: ${vscodePin}`);
  lensLog(`process: node ${process.version} on ${process.platform}/${process.arch}`);
  lensLog(`cwd: ${process.cwd()}`);

  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    lensLog("workspace folders: <none>");
  } else {
    folders.forEach((f, i) => {
      lensLog(`workspace folder[${i}]: ${f.uri.fsPath}`);
    });
  }

  const first = folders?.[0];
  const repoRoot =
    first === undefined ? null : LensResolver.resolveRepoRoot(first.uri.fsPath);
  lensLog(`resolved repo root: ${repoRoot ?? "<null — no .cairn/ ancestor found>"}`);

  if (repoRoot !== null) {
    const decPath = join(
      repoRoot,
      ".cairn/ground/decisions/decisions.ledger.yaml",
    );
    const invPath = join(
      repoRoot,
      ".cairn/ground/invariants/invariants.ledger.yaml",
    );
    reportLedger("decisions.ledger.yaml", decPath);
    reportLedger("invariants.ledger.yaml", invPath);
  }

  const config = vscode.workspace.getConfiguration("cairn");
  const keys = [
    "lens.enabled",
    "lens.inlineDecorations",
    "lens.gutterIcons",
    "lens.codeLens",
    "lens.decExplorer",
    "lens.inlineMode",
  ];
  for (const k of keys) {
    lensLog(`config cairn.${k} = ${JSON.stringify(config.get(k))}`);
  }

  const visible = vscode.window.visibleTextEditors;
  lensLog(`visible editors: ${visible.length}`);
  for (const ed of visible) {
    const scheme = ed.document.uri.scheme;
    const eligible = scheme === "file";
    lensLog(
      `  editor: scheme=${scheme} lang=${ed.document.languageId} ` +
        `eligible=${eligible} ${ed.document.uri.fsPath}`,
    );
  }

  if (runtime === null) {
    lensLog("runtime: <not wired> — provider activation skipped or failed");
  } else {
    lensLog("runtime: wired");
    lensLog(`  repoRoot: ${runtime.repoRoot}`);
    lensLog("  hover provider: live");
    lensLog("  decoration manager: live");
    lensLog("  code-lens provider: live");
    lensLog("  DEC explorer: live");
    lensLog(
      `  ledger watcher: armed (fired=${String(runtime.watcherFired)})`,
    );
    lensLog(
      "  watcher pattern: .cairn/ground/{invariants/invariants.ledger.yaml,decisions/decisions.ledger.yaml,scope-index.yaml}",
    );
  }
  lensLog("=== end diagnose ===");
}

function reportLedger(label: string, path: string): void {
  if (!existsSync(path)) {
    lensLog(`${label}: <missing> at ${path}`);
    return;
  }
  try {
    const stat = statSync(path);
    const text = readFileSync(path, "utf8");
    // Cheap entry counter — counts top-level list items (`- id:` or
    // `- v_id:`-shaped headers). Good enough for a sanity dump.
    const entries = text
      .split(/\r?\n/)
      .filter((l) => /^- (id|v_id|dec_id):/.test(l)).length;
    lensLog(
      `${label}: ${stat.size} bytes, ${entries} entries (mtime=${stat.mtime.toISOString()})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lensLog(`${label}: <read error> ${msg}`, "error");
  }
}
