/**
 * Cairn state-home resolver — the single source of truth for *where* a repo's
 * Cairn state lives. Committed mode (the default) returns `<repoRoot>/.cairn`,
 * byte-for-byte today's behavior. Ghost mode returns an out-of-repo directory
 * under `~/.cairn/state/<repo-id>/`, so nothing Cairn-shaped ever lands in the
 * client tree.
 *
 * This is pure indirection: every `paths.ts` helper (and every other call site
 * that used to hardcode `join(repoRoot, ".cairn", …)`) builds on `cairnHome`
 * here. Centralizing the state location is a standalone win independent of
 * ghost — it makes the location relocatable, testable, and a single seam.
 *
 * The resolver chicken-and-egg (the ghost flag normally lives in the config
 * file, but in ghost that file is *inside* the out-of-repo home) is broken by a
 * global registry outside any client repo: `~/.cairn/registry.yaml`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Expand a leading `~` to the operator's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Global Cairn state home — `~/.cairn/state/`. Hardcoded (the operator hates
 * env vars). Per-repo ghost state lives at `<stateHome>/<repo-id>/`, mirroring
 * the in-repo `.cairn/` layout (`ground/`, `config.yaml`, `git-hooks/`, …) but
 * physically outside every client repo tree.
 */
export function stateHome(): string {
  return join(homedir(), ".cairn", "state");
}

/** `~/.cairn/state/<repoId>` — the out-of-repo home for one ghost repo. */
export function ghostStateDir(repoId: string): string {
  return join(stateHome(), repoId);
}

/** `~/.cairn/registry.yaml` — the global repo→mode map, outside any repo. */
export function registryPath(): string {
  return join(homedir(), ".cairn", "registry.yaml");
}

/** One registry record. `<repo-id>` keys on the move-stable root-commit SHA. */
export interface RegistryEntry {
  /** "ghost" | "committed" — only "ghost" entries relocate state. */
  mode: string;
  /** Absolute out-of-repo state dir. */
  state_dir: string;
  /** Move-stable identity: the repo's root-commit SHA. */
  root_commit?: string;
  /** Last-seen absolute path of the client checkout (abs-path fallback). */
  last_path?: string;
}

interface Registry {
  repos?: Record<string, RegistryEntry>;
}

/* -------------------------------------------------------------------------- */
/* Resolution — memoized per process; registry-absent is the fast committed   */
/* path (one existsSync, no git shell).                                       */
/* -------------------------------------------------------------------------- */

const homeCache = new Map<string, string>();
const ghostCache = new Map<string, boolean>();

/**
 * Drop the memoized resolution for a repo (or all repos). Call after mutating
 * the registry — e.g. `cairn init --ghost` registers a repo, then seed must
 * resolve to the *new* out-of-repo home rather than a stale committed cache.
 */
export function invalidateCairnHomeCache(repoRoot?: string): void {
  if (repoRoot) {
    homeCache.delete(repoRoot);
    ghostCache.delete(repoRoot);
  } else {
    homeCache.clear();
    ghostCache.clear();
  }
}

/** Read `~/.cairn/registry.yaml`; null when absent/broken (→ committed). */
export function readRegistry(): Registry | null {
  const p = registryPath();
  if (!existsSync(p)) return null;
  try {
    const doc = parseYaml(readFileSync(p, "utf8"));
    return typeof doc === "object" && doc !== null ? (doc as Registry) : null;
  } catch {
    return null;
  }
}

/** The repo's root-commit SHA, or null (no git / no commits yet). */
function rootCommit(repoRoot: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "rev-list", "--max-parents=0", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * The ghost registry entry for this repo, or null when committed. Prefers the
 * move-stable root-commit identity (so moving/renaming the checkout doesn't
 * orphan state), falling back to an absolute-path match for pre-first-commit
 * repos.
 */
function ghostEntry(repoRoot: string): RegistryEntry | null {
  const reg = readRegistry();
  if (!reg?.repos) return null;
  const ghosts = Object.values(reg.repos).filter((e) => e?.mode === "ghost");
  if (ghosts.length === 0) return null;
  const rc = rootCommit(repoRoot);
  if (rc) {
    const byCommit = ghosts.find((e) => e.root_commit === rc);
    if (byCommit) return byCommit;
  }
  return ghosts.find((e) => e.last_path === repoRoot) ?? null;
}

/**
 * Resolve the Cairn state home for a repo — the base every path helper builds
 * on. Committed: `<repoRoot>/.cairn`. Ghost: the out-of-repo `state_dir`.
 */
export function cairnHome(repoRoot: string): string {
  const cached = homeCache.get(repoRoot);
  if (cached !== undefined) return cached;
  const entry = ghostEntry(repoRoot);
  const home = entry ? expandTilde(entry.state_dir) : join(repoRoot, ".cairn");
  homeCache.set(repoRoot, home);
  ghostCache.set(repoRoot, entry !== null);
  return home;
}

/** True when this repo is registered ghost. Registry lookup, memoized. */
export function isGhost(repoRoot: string): boolean {
  const cached = ghostCache.get(repoRoot);
  if (cached !== undefined) return cached;
  cairnHome(repoRoot); // populates both caches
  return ghostCache.get(repoRoot) ?? false;
}

/**
 * `join(cairnHome(repoRoot), ...segments)` — the workhorse builder that
 * replaces every `join(repoRoot, ".cairn", …)` outside `paths.ts`.
 */
export function cairnDir(repoRoot: string, ...segments: string[]): string {
  return join(cairnHome(repoRoot), ...segments);
}

/* -------------------------------------------------------------------------- */
/* Registration — written once at adoption (cairn init --ghost / cairn-adopt) */
/* -------------------------------------------------------------------------- */

/**
 * Register a repo as ghost in the global registry, keyed on its root-commit
 * SHA (abs-path key fallback for pre-first-commit repos), and return the
 * resolved out-of-repo state dir. Invalidates the resolver cache so subsequent
 * `cairnHome` calls relocate immediately.
 */
export function registerGhostRepo(repoRoot: string): RegistryEntry {
  const rc = rootCommit(repoRoot);
  const repoId = rc ?? repoRoot.replace(/[^A-Za-z0-9._-]/g, "_");
  const entry: RegistryEntry = {
    mode: "ghost",
    state_dir: ghostStateDir(repoId),
    last_path: repoRoot,
    ...(rc ? { root_commit: rc } : {}),
  };
  const reg: Registry = readRegistry() ?? {};
  reg.repos = reg.repos ?? {};
  reg.repos[repoId] = entry;
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, stringifyYaml(reg), "utf8");
  invalidateCairnHomeCache(repoRoot);
  return entry;
}
