import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  listMissions,
  loadDraftFromFile,
  previewRoadmap,
  resolveAnchorRoot,
  runMissionAccept,
  runMissionAdvance,
  runMissionClose,
  runMissionGet,
  runMissionReopen,
  runMissionStart,
  writeDraftToFile,
} from "@isaacriehm/cairn-core";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    "Usage: cairn mission <subcommand> [options]\n" +
      "  start --spec <path> --gate <prompt|auto|manual> [--draft-out <path>] [--no-llm]\n" +
      "                      Read spec, draft phases, save draft JSON for editing.\n" +
      "  accept --from <path>  Apply an edited draft JSON; writes roadmap.md + state.json.\n" +
      "  get                 Print active mission state (JSON).\n" +
      "  list                List active + done mission ids.\n" +
      "  advance <phase_id> [--force | --drop]\n" +
      "                      Mark phase done + advance cursor; --force allows zero-task advance;\n" +
      "                      --drop removes a drifted phase id from phase_progress.\n" +
      "  close <mission_id> --outcome <done|aborted> [--reason <text>]\n" +
      "                      Close + archive a mission.\n" +
      "  reopen <mission_id> Un-archive a closed mission.\n" +
      "\n" +
      "All subcommands accept --repo <path> (default: cwd).",
  );
  process.exit(1);
}

function resolveRepoRootFromFlags(flags: Record<string, string | boolean>): string {
  const flag = flags["repo"];
  // Explicit --repo wins; otherwise anchor at the adopted/git root, not
  // the launch subdir.
  return typeof flag === "string" ? resolve(flag) : resolveAnchorRoot(process.cwd());
}

export async function missionCli(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") usage();

  const rest = argv.slice(1);
  const parsed = parseArgs(rest);
  const repoRoot = resolveRepoRootFromFlags(parsed.flags);

  switch (subcommand) {
    case "start":
      await missionStart(repoRoot, parsed);
      break;
    case "accept":
      missionAccept(repoRoot, parsed);
      break;
    case "get":
      missionGet(repoRoot);
      break;
    case "list":
      missionList(repoRoot);
      break;
    case "advance":
      missionAdvance(repoRoot, parsed);
      break;
    case "close":
      missionClose(repoRoot, parsed);
      break;
    case "reopen":
      missionReopen(repoRoot, parsed);
      break;
    default:
      console.error(`Unknown mission subcommand: ${subcommand}`);
      usage();
  }
}

async function missionStart(repoRoot: string, parsed: ParsedFlags): Promise<void> {
  const specRaw = parsed.flags["spec"];
  const gateRaw = parsed.flags["gate"];
  if (typeof specRaw !== "string" || typeof gateRaw !== "string") {
    console.error("mission start: --spec <path> and --gate <prompt|auto|manual> required");
    process.exit(2);
  }
  if (gateRaw !== "prompt" && gateRaw !== "auto" && gateRaw !== "manual") {
    console.error(`mission start: --gate must be prompt|auto|manual (got ${gateRaw})`);
    process.exit(2);
  }
  const noLlm = parsed.flags["no-llm"] === true;

  let result;
  try {
    result = await runMissionStart({
      repoRoot,
      specPath: specRaw,
      exitGate: gateRaw,
      ...(noLlm ? { noLlm: true } : {}),
    });
  } catch (err) {
    console.error(`mission start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    previewRoadmap({
      title: result.proposed_title,
      specPath: result.spec_path,
      exitGate: result.exit_gate,
      phases: result.phases,
    }),
  );
  console.log("");

  const draftOut = parsed.flags["draft-out"];
  if (typeof draftOut === "string") {
    writeDraftToFile(resolve(draftOut), {
      title: result.proposed_title,
      spec_path: result.spec_path,
      exit_gate: result.exit_gate,
      phases: result.phases,
    });
    console.log(
      `Draft saved to ${draftOut}. Edit + run \`cairn mission accept --from ${draftOut}\`.`,
    );
  } else {
    console.log("Pass --draft-out <path> to save the draft, edit it, then `cairn mission accept --from <path>`.");
  }
}

function missionAccept(repoRoot: string, parsed: ParsedFlags): void {
  const fromRaw = parsed.flags["from"];
  if (typeof fromRaw !== "string") {
    console.error("mission accept: --from <draft-json-path> required");
    process.exit(2);
  }
  const path = resolve(fromRaw);
  if (!existsSync(path)) {
    console.error(`mission accept: draft file not found: ${path}`);
    process.exit(1);
  }
  let draft;
  try {
    draft = loadDraftFromFile(path);
  } catch (err) {
    console.error(`mission accept: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let result;
  try {
    result = runMissionAccept({
      repoRoot,
      title: draft.title,
      specPath: draft.spec_path,
      exitGate: draft.exit_gate,
      phases: draft.phases,
    });
  } catch (err) {
    console.error(`mission accept: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

function missionGet(repoRoot: string): void {
  const result = runMissionGet(repoRoot);
  console.log(JSON.stringify(result, null, 2));
}

function missionList(repoRoot: string): void {
  console.log(JSON.stringify(listMissions(repoRoot), null, 2));
}

function missionAdvance(repoRoot: string, parsed: ParsedFlags): void {
  const phaseId = parsed.positional[0];
  if (phaseId === undefined) {
    console.error("mission advance: <phase_id> required");
    process.exit(2);
  }
  const force = parsed.flags["force"] === true;
  const drop = parsed.flags["drop"] === true;
  if (force && drop) {
    console.error("mission advance: --force and --drop are mutually exclusive");
    process.exit(2);
  }
  let result;
  try {
    result = runMissionAdvance({
      repoRoot,
      phaseId,
      ...(force ? { force: true } : {}),
      ...(drop ? { drop: true } : {}),
    });
  } catch (err) {
    console.error(`mission advance: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

function missionClose(repoRoot: string, parsed: ParsedFlags): void {
  const missionId = parsed.positional[0];
  if (missionId === undefined) {
    console.error("mission close: <mission_id> required");
    process.exit(2);
  }
  const outcomeRaw = parsed.flags["outcome"];
  if (outcomeRaw !== "done" && outcomeRaw !== "aborted") {
    console.error("mission close: --outcome must be done|aborted");
    process.exit(2);
  }
  const reason = typeof parsed.flags["reason"] === "string" ? parsed.flags["reason"] : undefined;
  let result;
  try {
    result = runMissionClose(repoRoot, missionId, outcomeRaw, reason);
  } catch (err) {
    console.error(`mission close: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

function missionReopen(repoRoot: string, parsed: ParsedFlags): void {
  const missionId = parsed.positional[0];
  if (missionId === undefined) {
    console.error("mission reopen: <mission_id> required");
    process.exit(2);
  }
  let result;
  try {
    result = runMissionReopen(repoRoot, missionId);
  } catch (err) {
    console.error(`mission reopen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
