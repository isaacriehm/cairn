/**
 * `cairn doctor` — verify the adoption is healthy.
 * `cairn fix`    — auto-resolve the warnings doctor flags where we can.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  isAdopted,
  rebuildScopeIndex,
  runDoctor,
  runFix,
  type DoctorCheck,
  type DoctorReport,
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

function ensureAdopted(repoRoot: string): void {
  if (!existsSync(repoRoot)) {
    console.error(`cairn: repo root does not exist: ${repoRoot}`);
    process.exit(2);
  }
  if (!isAdopted(repoRoot)) {
    console.error(
      `cairn: ${repoRoot} is not cairn-adopted (no config.yaml). Run \`cairn init\` first.`,
    );
    process.exit(2);
  }
}

function iconFor(status: DoctorCheck["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warn":
      return "⚠";
    case "error":
      return "✗";
    case "info":
      return "○";
  }
}

function pad(label: string, width: number): string {
  if (label.length >= width) return label;
  return label + " ".repeat(width - label.length);
}

function renderReport(report: DoctorReport): void {
  process.stdout.write(`  ⬡ Cairn — ${report.projectName}\n`);
  process.stdout.write("\n");
  process.stdout.write("  Core\n");
  for (const c of report.checks.filter((c) => c.group === "core")) {
    process.stdout.write(
      `    ${iconFor(c.status)}  ${pad(c.label, 16)} ${c.detail}\n`,
    );
  }
  const ground = report.checks.filter((c) => c.group === "ground");
  if (ground.length > 0) {
    process.stdout.write("\n  Ground state\n");
    for (const c of ground) {
      process.stdout.write(
        `    ${iconFor(c.status)}  ${pad(c.label, 16)} ${c.detail}\n`,
      );
    }
  }
  const sensors = report.checks.filter((c) => c.group === "sensors");
  if (sensors.length > 0) {
    process.stdout.write("\n  Sensors\n");
    for (const c of sensors) {
      process.stdout.write(
        `    ${iconFor(c.status)}  ${pad(c.label, 28)} ${c.detail}\n`,
      );
    }
  }
  process.stdout.write("\n");
  if (report.errors === 0 && report.warnings === 0) {
    process.stdout.write("  All checks passed.\n");
  } else {
    process.stdout.write(
      `  ${report.warnings} warning${report.warnings === 1 ? "" : "s"}, ${report.errors} error${report.errors === 1 ? "" : "s"}. Run \`cairn fix\` to resolve automatically where possible.\n`,
    );
  }
}

export async function doctorCli(argv: string[]): Promise<void> {
  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);
  const report = runDoctor({ repoRoot });
  renderReport(report);
  if (report.errors > 0) process.exit(1);
  if (report.warnings > 0) process.exit(2);
  process.exit(0);
}

export async function fixCli(argv: string[]): Promise<void> {
  const repoRoot = parseRepoFlag(argv);
  ensureAdopted(repoRoot);

  process.stdout.write("⬡ cairn fix — running auto-resolutions…\n");
  const result = await runFix({
    repoRoot,
    rebuildScopeIndexFn: async (root) => {
      const r = await rebuildScopeIndex({ repoRoot: root });
      return { filesClassified: r.filesClassified };
    },
  });

  if (result.appliedFixes.length === 0 && result.manualFixes.length === 0) {
    process.stdout.write("  ✓ Nothing to fix.\n");
    process.exit(0);
  }
  for (const f of result.appliedFixes) {
    process.stdout.write(`  ✓ ${f}\n`);
  }
  if (result.manualFixes.length > 0) {
    process.stdout.write("\n  Manual fix needed:\n");
    for (const m of result.manualFixes) {
      const cmd = m.command !== null ? `  →  ${m.command}` : "";
      process.stdout.write(`    - ${m.check}${cmd}\n`);
    }
    process.exit(2);
  }
  process.exit(0);
}
