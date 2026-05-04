# Publish recipe — Cairn v0.1.0

One-time setup for publishing to `github.com/isaacriehm/cairn` + npm.

## Prerequisites

- npm account with access to the `@isaacriehm` scope (run `npm login` if not already authenticated).
- `gh` CLI logged in for the GitHub side, or use the web UI to create the public repo.
- `pnpm` 10.x.

## 1. Final dev sanity

```bash
pnpm install
pnpm -r build
pnpm --filter @isaacriehm/cairn check:layout
for s in plugin-layout resolve-attention stop-hook events session-state \
         status-line session-start handoff scope-index read-enrich init \
         ingestion-baseline tier0 gc lock source-comments rules-merge join \
         bypass-detection bootstrap-guard e2e-adoption e2e-daily-flow; do
  pnpm --filter @isaacriehm/cairn "smoke:$s"
done
```

All 22 smokes must pass. Build must be clean.

## 2. Push to the public GitHub repo

The current repo (`github.com/...your-private-mirror`) becomes the dev
backup. Push the clean working tree as the initial commit of the public
repo:

```bash
# In a fresh clone of the working tree (don't carry git history):
cp -R "/Users/user/Documents/DevPlus LLC/06 - Projects/Harness" ~/cairn-public
cd ~/cairn-public
rm -rf .git node_modules packages/*/node_modules packages/*/dist packages/*/*.tsbuildinfo
git init
git add -A
git commit -m "feat: initial release of Cairn v0.1.0"
git branch -M main
git remote add origin git@github.com:isaacriehm/cairn.git
git push -u origin main
git tag -a v0.1.0 -m "Cairn v0.1.0"
git push origin v0.1.0
```

The private mirror's git history retains the build sequence + BUILD_LOG —
useful for forensics but never pushed public.

## 3. Publish to npm

Two packages publish; the rest stay private workspace deps.

```bash
cd ~/cairn-public
pnpm install
pnpm -r build

# cairn-core depends on nothing in the workspace; publish first.
pnpm publish --filter @isaacriehm/cairn-core --access public

# cairn (CLI) depends on cairn-core; publish second.
pnpm publish --filter @isaacriehm/cairn --access public
```

Verify:

```bash
npm view @isaacriehm/cairn-core
npm view @isaacriehm/cairn
```

Test install in a scratch directory:

```bash
mkdir /tmp/scratch && cd /tmp/scratch
npm install -g @isaacriehm/cairn
which cairn
cairn --version          # should print 0.1.0
cd $(mktemp -d)
git init
cairn init               # full adoption walk
```

## 4. Register the Claude Code plugin

The plugin (`packages/cairn-frontend-claudecode/`) is distributed via
GitHub repo URL, not npm. From any Claude Code session:

```
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
```

The plugin's `.mcp.json` and `hooks/hooks.json` shell out to `cairn` and
`node ${CLAUDE_PLUGIN_ROOT}/../cairn-core/dist/...` paths. Both work as
long as the `cairn` CLI is on PATH (from step 3) AND the plugin clone
has the cairn-core sibling in its workspace layout.

For dev iteration on the plugin itself, link the workspace:

```bash
pnpm --filter @isaacriehm/cairn link --global
which cairn      # → workspace tsx wrapper, not the npm-published binary
```

## 5. Future releases

- Bump versions in `packages/*/package.json`.
- `pnpm -r build && smokes`.
- `git tag -a vX.Y.Z -m "Cairn vX.Y.Z" && git push origin vX.Y.Z`.
- `pnpm publish --filter @isaacriehm/cairn-core --access public`.
- `pnpm publish --filter @isaacriehm/cairn --access public`.

## 6. VS Code / Cursor extension (cairn-lens) — separate path

`@isaacriehm/cairn-lens` ships through VS Code Marketplace + Open VSX, not
npm. The package.json is wired with `vsce` scripts; deferred to a future
release.
