@echo off
rem cairn — plugin-bundled CLI for native Windows (cmd / PowerShell
rem fallback, when Git-Bash is not the Bash tool shell). Claude Code adds
rem bin/ to PATH; PATHEXT resolves bare `cairn` to this .cmd. Self-locates
rem the bundled cli.mjs relative to this file (%~dp0 = this dir + trailing
rem backslash) — CLAUDE_PLUGIN_ROOT is not set for Bash-tool processes.
node "%~dp0..\dist\cli.mjs" %*
