/**
 * `cairn components <sub>` — component registry tooling.
 *
 *   detect  backfill a `components:` config block into an adopted repo
 *   index   rebuild .cairn/ground/components/ from @cairn source headers
 *   check   validate headers; exit 1 on any hard finding (CI / manual gate)
 *   audit   advisory scan for inline rebuilds + name collisions (always exit 0)
 *   emit    build index + draft singleton §INVs + write audit baseline
 */

import { resolve } from "node:path";
import {
  buildComponentIndex,
  emitComponentStore,
  ensureComponentsConfig,
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
    "Usage: cairn components <detect|index|check|audit|emit> [--repo <path>]\n" +
      "  detect  backfill a components: config block into an adopted repo\n" +
      "  index   rebuild the derived component inventory from @cairn headers\n" +
      "  check   validate headers; exit 1 on any hard finding\n" +
      "  audit   advisory inline-rebuild + name-collision scan (exit 0)\n" +
      "  emit    build index + draft singleton §INVs + write audit baseline",
  );
  process.exit(2);
}

export async function componentsCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  const repoRoot = parseRepoFlag(argv.slice(1));

  switch (sub) {
    case "detect": {
      const r = await ensureComponentsConfig(repoRoot);
      switch (r.status) {
        case "not-adopted":
          console.error(
            "No .cairn/config.yaml found — this repo isn't adopted. " +
              "Run the cairn-adopt skill (or `cairn init`) first.",
          );
          process.exit(1);
          break;
        case "exists":
          console.log(
            "config.yaml already carries a components: block — left untouched.",
          );
          process.exit(0);
          break;
        case "none":
          console.log(
            "No recognizable component layout found — nothing written " +
              "(non-UI repo). Add a components: block to .cairn/config.yaml " +
              "by hand if this is wrong.",
          );
          process.exit(0);
          break;
        case "written": {
          console.log("Wrote a components: block into .cairn/config.yaml.");
          if (r.monorepo) {
            console.log(
              "Monorepo detected — every workspace is isolated by default. " +
                "Add `shared: true` to any workspace meant to expose its " +
                "components repo-wide.",
            );
          }
          console.log(
            "Next: header your components (`cairn components check` lists the " +
              "un-headered ones), then `cairn components emit`.",
          );
          process.exit(0);
          break;
        }
      }
      break;
    }
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
        const label =
          f.kind === "inline-rebuild"
            ? "INLINE-REBUILD?"
            : f.kind === "unregistered-component"
              ? "UNREGISTERED-COMPONENT:"
              : "NAME-COLLISION:";
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
    case "emit": {
      const r = emitComponentStore(repoRoot);
      if (r.skipped) {
        console.error(
          "No components: config — nothing to emit. Run " +
            "`cairn components detect` first.",
        );
        process.exit(1);
      }
      console.log(
        `Indexed ${r.indexed} component(s)` +
          (r.singletonsDrafted > 0
            ? `, drafted ${r.singletonsDrafted} singleton §INV(s)`
            : "") +
          ".",
      );
      if (r.baselinePath !== null) {
        console.log(
          `Queued ${r.missing} missing-header + ${r.auditFindings} audit ` +
            `finding(s) to ${r.baselinePath} — triage via the cairn-attention skill.`,
        );
      }
      if (r.missing > 0) {
        console.error(
          `\nWARNING: ${r.missing} component file(s) still missing @cairn ` +
            "headers. `cairn components check` will fail until they are headered.",
        );
      }
      process.exit(0);
      break;
    }
    default:
      usage();
  }
}
