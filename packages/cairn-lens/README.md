# Cairn Lens

VS Code / Cursor extension that surfaces Cairn citation context inline as
you edit. Read-only consumer of the same `.cairn/ground/` ledgers Claude
Code uses — no separate index, no embedded metadata in your source files.

## Install

### Option 1 — `.vsix` from a GitHub Release (recommended)

1. Download the latest `cairn-lens-vX.Y.Z.vsix` from
   [github.com/isaacriehm/cairn/releases](https://github.com/isaacriehm/cairn/releases).
2. In VS Code or Cursor:
   - **VS Code**: `Cmd/Ctrl+Shift+P` → `Extensions: Install from VSIX…` → pick the file.
   - **Cursor**: same — `Cmd/Ctrl+Shift+P` → `Extensions: Install from VSIX…`.
3. Reload the window.

### Option 2 — From source

```bash
git clone https://github.com/isaacriehm/cairn.git
cd cairn
pnpm install
pnpm -r build
pnpm --filter cairn-lens package
# Produces packages/cairn-lens/cairn-lens-X.Y.Z.vsix
```

Then install the `.vsix` per Option 1.

## Features

- **Hover** — point at a `§V<N>` token to see the resolved invariant title,
  status, and source decision. `TODO(TSK-<id>)` tokens resolve to the active
  task title.
- **Inline ghost text** — after each `§V<N>` token, the editor renders
  `✓ <title>` (active), `⚠ superseded by §V<M>` (superseded), or
  `? not in ledger` (orphan).
- **Gutter icons** — `●` active, `◐` superseded, `○` orphan.
- **Code Lens** — for files with decisions in scope per `scope-index.yaml`,
  shows a one-liner above the topmost function summarizing the bindings.
- **DEC Explorer** — optional sidebar panel listing the decisions in scope
  of the active editor's file.

## Configuration

In your VS Code / Cursor settings (`Cmd/Ctrl+,` → search "cairn"):

```json
{
  "cairn.lens.enabled": true,
  "cairn.lens.inlineDecorations": true,
  "cairn.lens.gutterIcons": true,
  "cairn.lens.codeLens": true,
  "cairn.lens.decExplorer": false
}
```

| Setting | Default | What |
|---------|---------|------|
| `cairn.lens.enabled` | `true` | Master switch. |
| `cairn.lens.inlineDecorations` | `true` | Ghost-text annotations after `§V<N>` tokens. |
| `cairn.lens.gutterIcons` | `true` | Per-line gutter status icons. |
| `cairn.lens.codeLens` | `true` | One-liner above functions when DECs apply. |
| `cairn.lens.decExplorer` | `false` | Sidebar tree view. Off by default — opt in. |

## Activation

The extension activates on `onStartupFinished` and inspects the workspace
for a `.cairn/` directory. If one isn't present, the extension stays
inert — no decorations, no providers registered. Adopt your project with
`cairn init` first.

## Compatibility

- VS Code 1.85+
- Cursor (any recent version — uses the same VS Code extension API)
- Open VSX-compatible editors (manual `.vsix` install)

The extension is read-only on `.cairn/ground/` ledgers; it never
modifies them. Safe to install in any harness-adopted project.
