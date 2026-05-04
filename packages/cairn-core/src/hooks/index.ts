/**
 * Claude Code hooks — runner functions + bin entrypoints.
 *
 * Bin entrypoints live at `dist/hooks/<event>.js` (one per event) so
 * the plugin manifest can invoke them via
 * `node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/hooks/<event>.js`
 * without depending on the `harness` umbrella CLI being on PATH.
 *
 * The umbrella CLI's `harness hook <event>` calls the same runners.
 */

export * from "./runners/index.js";
export * from "./post-tool-use/index.js";
