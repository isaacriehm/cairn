/**
 * Minimal glob matcher (no external dep). Supports `**`, `*`, `?`, and literal
 * segments. Patterns are POSIX-style; segments separator is forward slash.
 *
 * Mirror of `compileGlob` from src/mirror/dirty-overlap.ts — unified here so
 * both modules share the same matching semantics.
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
