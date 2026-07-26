import type { McpErrorPayload } from "../errors.js";
import { mcpError } from "../errors.js";
import { SpecIoError } from "../../missions/spec-io.js";

export function mapMissionCliError(err: unknown): McpErrorPayload {
  if (err instanceof SpecIoError) {
    if (err.code === "PATH_OUTSIDE_REPO") {
      return mcpError("PATH_OUTSIDE_REPO", err.message);
    }
    if (err.code === "FILE_NOT_FOUND") {
      return mcpError("FILE_NOT_FOUND", err.message);
    }
    return mcpError("INTERNAL_ERROR", err.message);
  }
  if (err instanceof Error) {
    if (err.message.includes("active mission already exists")) {
      return mcpError(
        "MISSION_ALREADY_ACTIVE",
        "An active mission already exists. Close or abort it before starting another (one active mission per repo).",
      );
    }
    if (err.message.includes("Haiku failed")) {
      return mcpError(
        "MISSION_DRAFT_FAILED",
        "Haiku failed to parse the spec doc. Retry, or pass `no_llm: true` to write a single-phase stub roadmap and hand-edit it.",
      );
    }
    return mcpError("INTERNAL_ERROR", err.message);
  }
  return mcpError("INTERNAL_ERROR", String(err));
}
