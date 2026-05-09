/**
 * Minimal glob matcher (no external dep). Supports `**`, `*`, `?`, and literal
 * segments. Patterns are POSIX-style; segments separator is forward slash.
 *
 * Single home for glob matching across the package — walker, GC sweep,
 * sensors, mirror dirty-overlap, and MCP tools all import from here.
 */
export function matchGlob(path: string, glob: string): boolean {
  return compileGlob(glob).test(path);
}

export function matchAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(path, g));
}

export function compileGlob(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c ?? "";
    }
  }
  re += "$";
  return new RegExp(re);
}
