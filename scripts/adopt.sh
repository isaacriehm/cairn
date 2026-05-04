#!/usr/bin/env bash
#
# adopt.sh — install Harness into an adopting project in one shot.
#
# Usage:
#   ./scripts/adopt.sh <target-project-dir> [extra harness-init flags...]
#
# Example:
#   ./scripts/adopt.sh "/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm"
#   ./scripts/adopt.sh ../mypalcrm --skip-mirror --skip-mapper
#
# What it does (in order):
#   1. pnpm -r build                         — compile all five workspace packages
#   2. pnpm pack each of the five            — tarballs land in each package dir
#   3. cd <target> && npm install <5 .tgz>   — single npm command, atomic resolve
#   4. cd <target> && npx harness init .     — wizard seeds .harness/, .mcp.json,
#                                              .claude/settings.json
#
# Re-running the script is safe: pack overwrites previous tarballs, npm install
# upgrades, and `harness init` collide-fails (--force re-seeds).
#
# Detects whether the target uses pnpm vs npm by looking for pnpm-lock.yaml; if
# pnpm is detected, uses `pnpm add -D <tarballs>` instead of `npm install`.

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: $(basename "$0") <target-project-dir> [extra harness-init flags...]" >&2
  exit 1
fi
shift

if [[ ! -d "$TARGET" ]]; then
  echo "adopt.sh: target dir does not exist: $TARGET" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "── Step 1/4: building all packages..."
pnpm -r build > /dev/null

echo "── Step 2/4: packing five tarballs..."
declare -a TARBALLS=()
declare -a SPECS=()
declare -a PKG_NAMES=(
  "@isaacriehm/cairn-core"
  "@isaacriehm/cairn-runtime"
  "@isaacriehm/cairn-frontend-discord"
  "@isaacriehm/cairn-frontend-stub"
  "@isaacriehm/cairn"
)
declare -a PKG_DIRS=(
  "packages/harness-core"
  "packages/harness-runtime"
  "packages/harness-frontend-discord"
  "packages/harness-frontend-stub"
  "harness"
)
for i in "${!PKG_DIRS[@]}"; do
  pkg="${PKG_DIRS[$i]}"
  name="${PKG_NAMES[$i]}"
  pushd "$ROOT/$pkg" > /dev/null
  TGZ=$(pnpm pack 2>&1 | tail -n 1 | tr -d '[:space:]')
  if [[ ! -f "$TGZ" ]]; then
    # pnpm pack older versions emit just the filename; resolve relative to pkg dir.
    TGZ="$(ls -t devplusllc-*.tgz | head -n 1)"
  fi
  ABS="$ROOT/$pkg/$TGZ"
  TARBALLS+=("$ABS")
  SPECS+=("${name}@file:${ABS}")
  echo "    + $TGZ"
  popd > /dev/null
done

ABS_TARGET="$(cd "$TARGET" && pwd)"
echo "── Step 3/4: installing into ${ABS_TARGET}..."

cd "$ABS_TARGET"

# Detect package manager. Priority:
#   1. --pm <name> flag (any pos override)
#   2. packageManager field in package.json
#   3. lockfile presence
#   4. fallback: pnpm if on PATH, else npm
PM=""
if [[ -f "package.json" ]]; then
  pmField="$(grep -oE '"packageManager"\s*:\s*"[^"]+"' package.json | sed -E 's/.*"([^"]+)"/\1/')"
  if [[ "$pmField" == pnpm* ]]; then PM="pnpm"; fi
  if [[ "$pmField" == npm* ]]; then PM="npm"; fi
  if [[ "$pmField" == yarn* ]]; then PM="yarn"; fi
fi
if [[ -z "$PM" ]]; then
  if [[ -f "pnpm-lock.yaml" || -f "pnpm-workspace.yaml" ]]; then PM="pnpm";
  elif [[ -f "yarn.lock" ]]; then PM="yarn";
  elif [[ -f "package-lock.json" ]]; then PM="npm";
  elif command -v pnpm > /dev/null 2>&1; then PM="pnpm";
  else PM="npm";
  fi
fi

echo "    using ${PM}"
case "$PM" in
  pnpm)
    # The umbrella tarball declares the four sub-packages with rewritten
    # version refs (workspace:* → 0.0.0). Without help, pnpm goes to the
    # registry to satisfy those transitive deps and 404s. Inject
    # pnpm.overrides into mypal's package.json so pnpm uses the supplied
    # tarballs instead. Idempotent: re-running rewrites paths if they
    # changed.
    HARNESS_ROOT="$ROOT" node <<'EOJS'
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.env.HARNESS_ROOT;
      if (!root) { console.error("HARNESS_ROOT not set"); process.exit(2); }
      const pkgPath = path.resolve("package.json");
      if (!fs.existsSync(pkgPath)) {
        console.error("package.json not found in cwd");
        process.exit(2);
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.pnpm = pkg.pnpm || {};
      pkg.pnpm.overrides = pkg.pnpm.overrides || {};
      const overrides = {
        "@isaacriehm/cairn-core": `file:${root}/packages/harness-core/isaacriehm-cairn-core-0.0.0.tgz`,
        "@isaacriehm/cairn-runtime": `file:${root}/packages/harness-runtime/isaacriehm-cairn-runtime-0.0.0.tgz`,
        "@isaacriehm/cairn-frontend-discord": `file:${root}/packages/harness-frontend-discord/isaacriehm-cairn-frontend-discord-0.0.0.tgz`,
        "@isaacriehm/cairn-frontend-stub": `file:${root}/packages/harness-frontend-stub/isaacriehm-cairn-frontend-stub-0.0.0.tgz`,
      };
      Object.assign(pkg.pnpm.overrides, overrides);
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log("    pnpm.overrides injected (4 entries)");
EOJS
    pnpm add -D "${SPECS[@]}"
    ;;
  yarn)
    yarn add -D "${TARBALLS[@]}"
    ;;
  npm|*)
    npm install --save-dev "${TARBALLS[@]}"
    ;;
esac

echo "── Step 4/4: running \`harness init .\`..."
npx harness init . "$@"

echo ""
echo "Adoption complete. Next:"
echo "  cd \"$ABS_TARGET\""
echo "  claude              # open Claude Code; SessionStart hook fires + MCP server starts"
echo ""
echo "Verify hook fired (run from another terminal once Claude Code is open):"
echo "  cat ~/.local/harness/state/session-start.jsonl | tail -1"
