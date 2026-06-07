/**
 * `cairn components <sub>` — component registry tooling.
 *
 *   index   rebuild .cairn/ground/components/ from @cairn source headers
 *   check   validate headers; exit 1 on any hard finding (CI / manual gate)
 *   audit   advisory scan for inline rebuilds + name collisions (always exit 0)
 */

import { resolve } from "node:path";
import {
  buildComponentIndex,
  runComponentAudit,
  runComponentCheck,
} from "@isaacriehm/cairn-core";

function parseRepoFlag(argv: string[]): string {
  const idx = argv.indexOf("--repo");
  if (idx === -1) return process.cwd();
  const candidate = argv[idx + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    console.error("--repo requires a path argument");
    process.exit(2);
  }
  return resolve(candidate);
}

function usage(): never {
  console.error(
    "Usage: cairn components <index|check|audit> [--repo <path>]\n" +
      "  index   rebuild the derived component inventory from @cairn headers\n" +
      "  check   validate headers; exit 1 on any hard finding\n" +
      "  audit   advisory inline-rebuild + name-collision scan (exit 0)",
  );
  process.exit(2);
}

export async function componentsCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  const repoRoot = parseRepoFlag(argv.slice(1));

  switch (sub) {
    case "index": {
      const r = buildComponentIndex(repoRoot);
      for (const rel of r.written) {
        console.log(`.cairn/ground/components/${rel}`);
      }
      for (const rel of r.orphansRemoved) {
        console.log(`removed orphan slice .cairn/ground/components/${rel}`);
      }
      console.log(
        `Indexed ${r.total} component(s) across ${r.workspaces} workspace(s) ` +
          `(~${r.tokensApprox} tokens to load the largest slice).`,
      );
      if (r.missing > 0) {
        console.error(
          `\nWARNING: ${r.missing} component file(s) missing @cairn headers. ` +
            "`cairn components check` will fail until they are headered.",
        );
      }
      process.exit(0);
      break;
    }
    case "check": {
      const r = runComponentCheck(repoRoot);
      for (const f of r.findings) {
        const tag = f.severity === "hard" ? "ERROR" : "WARN ";
        console.error(`${tag} ${f.message}`);
      }
      if (r.hardFailures > 0) {
        console.error(
          `\nCairn component check FAILED — ${r.hardFailures} error(s). ` +
            "The task is not complete until this passes.",
        );
        process.exit(1);
      }
      console.log(
        `Component check passed — ${r.total} component(s), ` +
          `${r.workspaces} workspace(s)` +
          (r.softFindings > 0 ? `, ${r.softFindings} warning(s)` : "") +
          ".",
      );
      process.exit(0);
      break;
    }
    case "audit": {
      const r = runComponentAudit(repoRoot);
      for (const f of r.findings) {
        const label = f.kind === "inline-rebuild" ? "INLINE-REBUILD?" : "NAME-COLLISION:";
        console.log(`${label} ${f.message}`);
        console.log(`  ladder: ${f.recommendation}.`);
      }
      console.log(
        r.findings.length > 0
          ? `\nAudit found ${r.findings.length} item(s) to triage. Advisory only — ` +
              "fix via the decision ladder, or dismiss with a reason."
          : "Audit clean — no probable inline rebuilds or name collisions found.",
      );
      process.exit(0);
      break;
    }
    default:
      usage();
  }
}
