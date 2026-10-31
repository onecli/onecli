import type { AppPermissionDefinition } from "./types";

/**
 * PostgreSQL. Agents reach a connected database through the gateway's
 * database front door, which classifies every statement and judges it as one
 * of three synthetic requests on the connection's reserved policy host
 * (`<connection-id>.postgres.onecli.invalid`, which never resolves):
 *
 * - `GET /sql/read`: statements that provably only read;
 * - `POST /sql/write`: data changes, row locks, and anything not provably a
 *   read (an unknown function counts as a write);
 * - `POST /sql/schema`: DDL, privileges, and server-wide actions.
 *
 * The paths and methods are pinned by the gateway's
 * `dbproxy::statement::StatementClass::policy_request`.
 */
const HOST = "*.postgres.onecli.invalid";

export const postgresPermissions: AppPermissionDefinition = {
  provider: "postgres",
  // The front door judges every statement as exactly one of the three
  // requests below, so nothing outside them exists to allow: the catalog is
  // the whole boundary, and anything else is refused rather than held.
  unlisted: "block",
  // ...and so the dialog shows no "Not listed above" rows: they could never
  // match a statement.
  exhaustive: true,
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "sql_read",
          name: "Read data",
          description:
            "Run queries that only read: SELECT, EXPLAIN, COPY TO the client",
          hostPattern: HOST,
          pathPattern: "/sql/read",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "sql_write",
          name: "Change data",
          description:
            "INSERT, UPDATE, DELETE, MERGE, COPY FROM the client, row locks, and functions OneCLI cannot prove read-only",
          hostPattern: HOST,
          pathPattern: "/sql/write",
          method: "POST",
        },
        {
          id: "sql_schema",
          name: "Change the schema",
          description:
            "CREATE, ALTER, DROP, GRANT, TRUNCATE, VACUUM and other schema or server-wide changes",
          hostPattern: HOST,
          pathPattern: "/sql/schema",
          method: "POST",
        },
      ],
    },
  ],
};
