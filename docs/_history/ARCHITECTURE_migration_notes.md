---
type: history
status: archived
audience: dual
generated: 2026-05-04
purpose: Preserves the §6 + §7 content from `docs/ARCHITECTURE.md` v1 (pre-9fe2b95). Migration is complete; this file is blame-archaeology only.
---

# Architecture migration notes (historical)

The single `harness/` package was split into four workspace packages
(`harness-core`, `harness-runtime`, `harness-frontend-discord`,
`harness-frontend-stub`) in commit `9fe2b95`. The migration steps and
open-questions list below were active during planning; they're
preserved here for blame.

## Migration path (single → multi-package)

1. **Skeleton packages** — create `packages/{harness-core, harness-runtime, harness-frontend-discord, harness-frontend-stub}/{package.json, tsconfig.json, src/index.ts}`.
2. **Update workspace** — `pnpm-workspace.yaml` adds `packages/*`.
3. **Move directories** — `git mv` the contents per the §3 layout in `docs/ARCHITECTURE.md`.
4. **Rewrite imports** — `from "../foo/bar.js"` → `from "@devplusllc/harness-core"` etc.
5. **Update top-level `harness/` package.json** — depend on the four sub-packages.
6. **Re-typecheck + re-smoke** — fix the inevitable circular-import gotchas.
7. **Bump versions** — each sub-package gets its own semver. Initial release is 0.0.0 across the board.

The git-mv approach preserves blame across the move. History was not rewritten.

## Open questions for next session (now answered)

1. **Where does `inbox.ts` live?** Answered: `harness-core/src/inbox.ts` — top-level state-layer concern.
2. **Where does `voice/` live?** Answered: `harness-core/src/voice/` — runtime's UAT rejection flow consumes `transcribeUrl`, so voice can't live in a frontend adapter.
3. **Smoke split.** Answered: smokes stay in `harness/scripts/` (cross-cutting). Per-package smokes deferred until a real need.
4. **Versioning.** Answered: lockstep 0.0.0 until first ship; independent semver post-release.
5. **`@devplusllc/` scope.** Answered: all four packages publish under `@devplusllc/`.
6. **CLI bin location.** Answered: stays in `harness/` umbrella (`harness/dist/cli/index.js`).
