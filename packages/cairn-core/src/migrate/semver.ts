/**
 * Minimal semver comparison for migration selection. No external dep.
 *
 * Parses `MAJOR.MINOR.PATCH` (ignoring any `-prerelease` / `+build` suffix)
 * and compares numerically. Non-conforming strings sort as `0.0.0`, which is
 * the conservative choice for an absent / malformed pin (everything pending).
 */

function parse(v: string): [number, number, number] {
  const core = v.trim().split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  const n = (i: number): number => {
    const x = Number.parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(x) ? x : 0;
  };
  return [n(0), n(1), n(2)];
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function semverCmp(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function semverGt(a: string, b: string): boolean {
  return semverCmp(a, b) > 0;
}

export function semverLte(a: string, b: string): boolean {
  return semverCmp(a, b) <= 0;
}
