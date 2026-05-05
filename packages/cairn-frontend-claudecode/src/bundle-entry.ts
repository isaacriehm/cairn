// Entry point bundled to dist/cli.cjs by esbuild.
// Side-effect import — the CLI script reads process.argv at top level and
// dispatches to the matching subcommand. The Claude Code plugin manifest
// invokes the bundle as `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs <subcommand> ...`.
import "@isaacriehm/cairn/cli";
