/**
 * SQL driver dispatcher.
 *
 * Loads `.harness/config/probes/sql.yaml`, resolves the SqlProbe's
 * `connection` key to a typed connection config, and routes the query
 * to the matching driver.
 */

import type { SqlConnection, SqlDriver, SqlQueryResult } from "./types.js";
import { loadSqlConnections } from "./config.js";
import { mysqlDriver } from "./mysql.js";
import { pgDriver } from "./pg.js";
import { sqliteDriver } from "./sqlite.js";

export type { SqlConnection, SqlConnectionsConfig, SqlDriver, SqlDriverKind, SqlQueryResult, SqliteConnection, PostgresConnection, MysqlConnection } from "./types.js";
export { loadSqlConnections, sqlConfigPath } from "./config.js";
export { sqliteDriver, pgDriver, mysqlDriver };

const DRIVERS: Record<string, SqlDriver> = {
  sqlite: sqliteDriver,
  postgres: pgDriver,
  mysql: mysqlDriver,
};

export interface ResolveConnectionResult {
  connection: SqlConnection;
  driver: SqlDriver;
}

export class SqlConnectionMissingError extends Error {
  constructor(key: string) {
    super(
      `sql connection "${key}" not configured — add it to .harness/config/probes/sql.yaml or run \`harness setup:uat-sql\``,
    );
    this.name = "SqlConnectionMissingError";
  }
}

/** Look up a connection by key + driver from the project config. */
export function resolveConnection(repoRoot: string, key: string): ResolveConnectionResult | null {
  const config = loadSqlConnections(repoRoot);
  const connection = config.connections[key];
  if (!connection) return null;
  const driver = DRIVERS[connection.driver];
  if (!driver) return null;
  return { connection, driver };
}

/** Run a query through the dispatcher. Throws on missing connection or driver error. */
export async function runQuery(args: {
  repoRoot: string;
  connectionKey: string;
  sql: string;
}): Promise<SqlQueryResult> {
  const resolved = resolveConnection(args.repoRoot, args.connectionKey);
  if (!resolved) throw new SqlConnectionMissingError(args.connectionKey);
  return resolved.driver.query(resolved.connection, args.sql);
}
