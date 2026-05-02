/**
 * Load `.harness/config/probes/sql.yaml`.
 *
 * Path resolution:
 *   1. <repoRoot>/.harness/config/probes/sql.yaml — project override
 *   2. (no fallback; missing config = no sql connections)
 *
 * Returns an empty `connections` map when the file is missing so callers
 * can produce a clean "no such connection" error instead of throwing on
 * read.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SqlConnection, SqlConnectionsConfig } from "./types.js";

export function sqlConfigPath(repoRoot: string): string {
  return join(repoRoot, ".harness", "config", "probes", "sql.yaml");
}

export function loadSqlConnections(repoRoot: string): SqlConnectionsConfig {
  const path = sqlConfigPath(repoRoot);
  if (!existsSync(path)) return { connections: {} };
  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const connectionsRaw = (raw["connections"] ?? {}) as Record<string, unknown>;
  const connections: Record<string, SqlConnection> = {};
  for (const [key, value] of Object.entries(connectionsRaw)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const driver = v["driver"];
    if (driver === "sqlite" && typeof v["file"] === "string") {
      connections[key] = { driver: "sqlite", file: v["file"] };
    } else if (driver === "postgres" && typeof v["host"] === "string" && typeof v["database"] === "string") {
      connections[key] = {
        driver: "postgres",
        host: v["host"],
        database: v["database"],
        ...(typeof v["port"] === "number" ? { port: v["port"] } : {}),
        ...(typeof v["user_env"] === "string" ? { user_env: v["user_env"] } : {}),
        ...(typeof v["password_env"] === "string" ? { password_env: v["password_env"] } : {}),
        ...(typeof v["ssl"] === "boolean" ? { ssl: v["ssl"] } : {}),
      };
    } else if (driver === "mysql" && typeof v["host"] === "string" && typeof v["database"] === "string") {
      connections[key] = {
        driver: "mysql",
        host: v["host"],
        database: v["database"],
        ...(typeof v["port"] === "number" ? { port: v["port"] } : {}),
        ...(typeof v["user_env"] === "string" ? { user_env: v["user_env"] } : {}),
        ...(typeof v["password_env"] === "string" ? { password_env: v["password_env"] } : {}),
      };
    }
  }
  return { connections };
}
