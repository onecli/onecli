import type { AppPermissionDefinition } from "./types";

// Snowflake's SQL API executes arbitrary SQL through one endpoint
// (POST /api/v2/statements), so statement submission is a WRITE tool even
// though many statements are reads — the path carries no signal about what
// the SQL does. No wildcards for the same reason: an "all reads" umbrella
// over an arbitrary-SQL provider would be misleading.
export const snowflakePermissions: AppPermissionDefinition = {
  provider: "snowflake",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "statements_get",
          name: "Get statement status",
          description: "Check execution status and fetch query results",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/statements/*",
          method: "GET",
        },
        {
          id: "databases_list",
          name: "List databases",
          description: "List databases, schemas, and tables",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/databases",
          method: "GET",
        },
        {
          id: "databases_get",
          name: "Browse database objects",
          description: "Get databases and browse their schemas and tables",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/databases/*",
          method: "GET",
        },
        {
          id: "warehouses_list",
          name: "List warehouses",
          description: "List virtual warehouses",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/warehouses",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "statements_submit",
          name: "Execute SQL",
          description:
            "Submit SQL statements for execution (queries, DML, and DDL)",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/statements",
          method: "POST",
        },
        {
          id: "statements_cancel",
          name: "Cancel statement",
          description: "Cancel a running SQL statement",
          hostPattern: "*.snowflakecomputing.com",
          pathPattern: "/api/v2/statements/*/cancel",
          method: "POST",
        },
      ],
    },
  ],
};
