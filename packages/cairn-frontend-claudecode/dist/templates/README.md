# `templates/` — files the init script copies into adopted projects

This directory ships with the `@isaacriehm/cairn` npm package. It is the seed for `.cairn/` and `.archive/` inside any project that runs:

```sh
npx @isaacriehm/cairn init <repo-dir>
```

Layout mirrors `docs/FILESYSTEM_LAYOUT.md`. The init script:

1. Copies `templates/.cairn/config/*` into `<repo-dir>/.cairn/config/` (preserving the `<project_name>:` placeholder; the script then replaces it with the adopting project's package name).
2. Copies `templates/.cairn/ground/manifest.yaml` (empty stub; daemon populates).
3. Copies `templates/.archive/README.md` into `<repo-dir>/.archive/`.
4. Creates the runtime directories (`runs/`, `inbox/`, `transcripts/`, `tasks/`, `staleness/`, `ground/{decisions,invariants,canonical-map,schema,routes,events}/`) and adds them to the project's `.gitignore` per spec §9.

This directory is **NOT** Cairn's own state. The Cairn package source repo is not self-hosted; it is the source for the published npm package.

## Why placeholders?

The `<project_name>:` block in `templates/.cairn/config/workflow.md` is a placeholder by design. The init script reads the adopting project's `package.json name` (or directory name as fallback), normalizes it (lowercase, non-alphanumerics → underscores), and replaces every occurrence of `<project_name>` in the copied file. Cairn package code reads the project block at runtime via `Object.keys()` lookup — never by hardcoded project name (per L50, operator answer S1).

## Editing templates

Templates are the single source of seed configuration. Changes here flow to every freshly-adopted project on next `npx @isaacriehm/cairn init`. Existing adoptions are unaffected — they own their copies.
