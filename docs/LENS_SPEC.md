---
type: spec
status: stub
audience: dual
generated: 2026-05-04
depends-on:
  - docs/PRIMER.md (§8.5)
  - docs/READ_ENRICHER_SPEC.md
build-scope: out-of-scope for initial build
---

# Harness — Lens Spec

**Harness Lens** is a VS Code / Cursor extension that delivers citation context to human developers the same way the Read enricher delivers it to Claude Code — by reading `.harness/ground/` at resolution time, not by embedding anything in source.

---

## 1. The symmetry principle

Two surfaces, one resolution chain:

| Who reads the file | How citations are resolved |
|--------------------|---------------------------|
| Claude Code (Read tool) | PostToolUse hook prepends citation legend to tool response |
| Human developer (editor) | Lens extension renders inlay hints / hovers from ledger |

The source file is identical in both cases. `// §V0023` is `// §V0023`. No essays, no drift. The meaning is authoritative because it comes from the ledger — not from whoever wrote the comment.

---

## 2. Features

### 2.1 Hover providers

**Invariant hover** — when cursor is on a `§V<N>` token:
```
§V0023  null-check before array destructure  [active]

Scope: src/auth/**
Added: TSK-0041 (auth refactor)
Sensor: §V0023-sensor.ts
```

**Task hover** — when cursor is on a `TODO(TSK-<id>)` token:
```
TSK-auth-refactor  bearer token validation  [in-progress]

Assigned: current run
Spec: .harness/tasks/active/TSK-auth-refactor/spec.tightened.md
```

### 2.2 Inline decorations (inlay-hint style)

After a `§V<N>` token, the Lens renders ghost text in the editor gutter or at end-of-line:

```ts
await verifyPassword(hash, input); // §V0023  ← ✓ null-check before array destructure
```

Ghost text style (muted, non-selectable):
- Active invariant: `✓ <title>` (muted green)
- Superseded: `⚠ superseded by §V<M>` (muted yellow)
- Not found: `? not in ledger` (muted red)

Toggled via VS Code setting `harness.lens.inlineDecorations` (default: on).

### 2.3 Gutter icons

Gutter column shows citation health at a glance:
- `●` active
- `◐` superseded
- `○` not found

Clicking a gutter icon opens the full invariant or decision panel.

### 2.4 Code lens (above functions)

For functions/classes whose file path matches a decision's `scope_globs`, a Code Lens line appears above the function signature:

```
  ⬡ 2 decisions in scope  ·  1 invariant  ·  View all
async function login(...) {
```

Clicking "View all" opens the DEC/invariant panel filtered to this file's scope.

### 2.5 DEC Explorer sidebar panel

Optional side panel showing all decisions and invariants whose `scope_globs` match the currently open file. Sortable by status, tier, date. Click to open full DEC/invariant file.

---

## 3. Resolution logic

The Lens reuses `ledger-cache.ts` from `harness-core/src/hooks/post-tool-use/` as a shared library.

Resolution steps:
1. Find workspace root by walking up from open file until `.harness/` is found
2. Load `invariants.ledger.yaml` and `decisions.ledger.yaml` (LRU cache, keyed by `repoRoot + mtime`)
3. For each citation token found in the visible viewport, resolve ID → `{ title, status, scope }`
4. Render hover / decoration

Cache invalidation: file watcher on both ledger files. When the daemon writes a new invariant or GC runs, decorations refresh within ~500ms.

---

## 4. Package layout

```
packages/harness-lens/
├── src/
│   ├── extension.ts            — entry point, registers providers
│   ├── providers/
│   │   ├── hover-provider.ts   — hover cards for §V and TSK tokens
│   │   ├── decoration-provider.ts  — inlay hints + gutter icons
│   │   └── lens-provider.ts    — code lens above functions
│   ├── panel/
│   │   └── dec-explorer.ts     — sidebar tree view
│   └── resolver.ts             — thin wrapper around harness-core ledger-cache
├── package.json                — VS Code extension manifest
└── tsconfig.json
```

**Dependency on harness-core:** `harness-lens` imports `ledger-cache` from `@devplusllc/harness-core`. This is a read-only, filesystem-only dependency — the Lens never calls the MCP server and never spawns a subprocess.

---

## 5. Configuration (`settings.json`)

```json
{
  "harness.lens.enabled": true,
  "harness.lens.inlineDecorations": true,
  "harness.lens.gutterIcons": true,
  "harness.lens.codeLens": true,
  "harness.lens.decExplorer": false
}
```

---

## 6. Out-of-scope for initial build

The Lens is a separate package and VS Code extension — it is not part of the `harness-core` or `harness` packages built in the overnight session. The shared `ledger-cache.ts` module (built in Task 5 of MASTER_PROMPT.md) is the only prerequisite. Once that module exists, the Lens can be built independently.

Distribution: VS Code Marketplace as `devplusllc.harness-lens`. Also works in Cursor via the VS Code extension compatibility layer.

---

## 7. Non-goals

- The Lens does not write to ground state
- The Lens does not call the MCP server or spawn subprocesses
- The Lens does not show AI-session context (context window usage, active task status) — that's the status line in Claude Code, not the editor
- The Lens does not modify source files — it is purely decorative / informational
