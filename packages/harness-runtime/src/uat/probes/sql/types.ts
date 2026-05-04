/**
 * SQL probe driver types.
 *
 * Connection config loaded from `.harness/config/probes/sql.yaml`. v1
 * supports `sqlite` (zero-server, via better-sqlite3); `postgres` and
 * `mysql` are placeholders that return helpful errors until Phase 11.5b
 * lands their drivers.
 */

export type SqlDriverKind = "sqlite" | "postgres" | "mysql";

export interface SqliteConnection {
  driver: "sqlite";
  /** Absolute path to the .db file. Use `:memory:` for an ephemeral DB. */
  file: string;
}

export interface PostgresConnection {
  driver: "postgres";
  host: string;
  port?: number;
  database: string;
  /** ENV var names for credentials (operator's hardline against literal secrets in YAML). */
  user_env?: string;
  password_env?: string;
  ssl?: boolean;
}

export interface MysqlConnection {
  driver: "mysql";
  host: string;
  port?: number;
  database: string;
  user_env?: string;
  password_env?: string;
}

export type SqlConnection = SqliteConnection | PostgresConnection | MysqlConnection;

export interface SqlConnectionsConfig {
  /** Mapping from connection key (the SqlProbe.connection field) → connection config. */
  connections: Record<string, SqlConnection>;
}

export interface SqlQueryResult {
  rowcount: number;
  rows: Record<string, unknown>[];
}

export interface SqlDriver {
  kind: SqlDriverKind;
  /** Run a single SELECT/SHOW query. Mutating queries are rejected. */
  query(connection: SqlConnection, sql: string): Promise<SqlQueryResult>;
}
