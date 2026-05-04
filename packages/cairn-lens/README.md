# Cairn Lens

VS Code extension that delivers cairn citation context to human developers
the same way the Read enricher delivers it to Claude Code: by reading
`.cairn/ground/` ledgers at resolution time, not by embedding anything in
the source file.

## Features

- **Hover** — point at a `§V<N>` token to see the resolved invariant title,
  status, and source decision. `TODO(TSK-<id>)` tokens resolve to the active
  task title.
- **Inline ghost text** — after each `§V<N>` token, the editor renders
  `✓ <title>` (active), `⚠ superseded by §V<M>` (superseded), or
  `? not in ledger` (orphan).
- **Gutter icons** — `●` active, `◐` superseded, `○` orphan.
- **Code lens** — for files with decisions in scope per `scope-index.yaml`,
  shows a one-liner above the topmost function.
- **DEC explorer** — optional sidebar panel listing the rules in scope of the
  active editor's file.

## Configuration

```json
{
  "cairn.lens.enabled": true,
  "cairn.lens.inlineDecorations": true,
  "cairn.lens.gutterIcons": true,
  "cairn.lens.codeLens": true,
  "cairn.lens.decExplorer": false
}
```

## Activation

The extension activates on `onStartupFinished` and inspects the workspace
for a `.cairn/` directory. If one is not present, the extension stays
inert — no decorations, no providers registered.

## Spec

See `docs/LENS_SPEC.md` in the cairn monorepo.
