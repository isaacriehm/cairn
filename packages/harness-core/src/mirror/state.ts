import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { mirrorRecordPath } from "./paths.js";
import type { MirrorRecord, ProjectName } from "./types.js";

const MirrorRecordSchema = z.object({
  projectName: z.string().min(1),
  userTreePath: z.string().min(1),
  originUrl: z.string().min(1),
  defaultBranch: z.string().min(1),
  mirrorPath: z.string().min(1),
  lastSyncedAt: z.string().nullable(),
  lastSha: z.string().nullable(),
  createdAt: z.string().min(1),
});

export function readMirrorRecord(projectName: ProjectName): MirrorRecord | null {
  const path = mirrorRecordPath(projectName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return MirrorRecordSchema.parse(parsed);
}

export function writeMirrorRecord(record: MirrorRecord): void {
  const validated = MirrorRecordSchema.parse(record);
  const path = mirrorRecordPath(record.projectName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export function requireMirrorRecord(projectName: ProjectName): MirrorRecord {
  const record = readMirrorRecord(projectName);
  if (!record) {
    throw new Error(
      `No mirror record for project "${projectName}". Run \`harness mirror init\` first.`,
    );
  }
  return record;
}
