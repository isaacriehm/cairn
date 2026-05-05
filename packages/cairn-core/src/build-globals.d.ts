// Build-time constants injected by esbuild --define when building the
// Claude Code plugin's self-contained bundle (packages/cairn-frontend-
// claudecode/dist/cli.cjs). In the dev / npm-published builds these are
// undefined, and the runtime falls back to import.meta.url-relative
// filesystem walks.
declare const __CAIRN_BUNDLED__: boolean | undefined;
declare const __CAIRN_VERSION__: string | undefined;
