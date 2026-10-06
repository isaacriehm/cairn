# @isaacriehm/cairn-core

The engine behind [Cairn](https://github.com/isaacriehm/cairn): the MCP
server, the diff sensors that run at pre-commit and in CI, the hook runners
the agent plugin calls, and the one-time adoption pipeline.

Most people never install this directly. It comes in through the
[`@isaacriehm/cairn`](https://www.npmjs.com/package/@isaacriehm/cairn) CLI
or the Claude Code / Cursor / Codex plugin. Install it on its own only if you
are building another front end on the same `.cairn/` ground state.

```bash
npm install @isaacriehm/cairn-core
```

Pre-1.0: exports can change between minor versions.

- Package boundaries: [`docs/ARCHITECTURE.md`](https://github.com/isaacriehm/cairn/blob/main/docs/ARCHITECTURE.md)
- MCP tools: [`docs/MCP_SURFACE.md`](https://github.com/isaacriehm/cairn/blob/main/docs/MCP_SURFACE.md)
- `.cairn/` layout: [`docs/FILESYSTEM_LAYOUT.md`](https://github.com/isaacriehm/cairn/blob/main/docs/FILESYSTEM_LAYOUT.md)

MIT © Isaac Riehm
