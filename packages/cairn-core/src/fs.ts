import { type Dirent, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Write `data` to `path`, creating parent directories as needed.
 * Encoding is always UTF-8.
 */
export function writeFileSafe(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, "utf8");
}

/**
 * Generic directory walker options.
 */
export interface WalkFsOptions {
  /** The root directory to start walking from. */
  dir: string;
  /** Optional set of directory names to skip (e.g., .git, node_modules). */
  skipDirs?: Set<string>;
  /** 
   * Callback for each file found.
   * @param rel Repo-relative path (if repoRoot provided) or dir-relative path.
   * @param abs Absolute path to the file.
   * @param entry The Dirent object.
   */
  onFile?: (rel: string, abs: string, entry: Dirent) => void;
  /**
   * Callback for each directory found.
   * @returns false to skip recursion into this directory.
   */
  onDir?: (rel: string, abs: string, entry: Dirent) => boolean | void;
  /** 
   * If provided, relative paths passed to callbacks will be relative to this root.
   * If not provided, paths will be relative to `dir`.
   */
  repoRoot?: string;
}

/**
 * Generic recursive directory walker.
 */
export function walkFs(opts: WalkFsOptions): void {
  const { dir, skipDirs, onFile, onDir, repoRoot } = opts;
  const root = repoRoot ?? dir;

  const stack: string[] = [dir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (currentDir === undefined) break;

    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const abs = join(currentDir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (skipDirs?.has(entry.name)) continue;
        const shouldRecurse = onDir ? onDir(rel, abs, entry) : true;
        if (shouldRecurse !== false) {
          stack.push(abs);
        }
      } else if (entry.isFile()) {
        if (onFile) onFile(rel, abs, entry);
      }
    }
  }
}
