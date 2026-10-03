import type { AppPermissionDefinition } from "./types";

// Salesforce's REST API is versioned in the path (`/services/data/v66.0/...`),
// so every pattern carries a `v*` segment. The single-`*` host pattern spans
// label boundaries, covering production, sandbox and the partitioned
// non-production My Domain hosts alike.
//
// Scope: the core REST surface an agent uses to read and edit records.
// Composite, Bulk, Apex REST and GraphQL are deliberately absent — they express
// arbitrary multi-object work that these per-tool permissions could not
// honestly describe. `salesforce-path-scope.test.ts` pins that exclusion.
//
// ── PATH PATTERN DISCIPLINE — do not "simplify" these ──────────────────────
// `pathMatches` picks its regime from the pattern's SHAPE:
//   • `*` as the last character with no earlier `*` → RAW PREFIX. So
//     `/services/data/v*` would match `/services/data/v66.0/graphql`,
//     `/composite` and `/jobs/query` — silently granting the surfaces above.
//   • a `*` anywhere earlier → SEGMENT matcher, which pins depth, except that
//     a trailing standalone `*` still consumes one or more segments.
// Therefore a tool whose FINAL segment is a wildcard is written with a
// TRAILING SLASH to force exact depth. In the segment regime that slash is
// optional in the request: `/sobjects/*/` matches `/sobjects/Contact/` and
// `/sobjects/Contact` (Salesforce accepts both), never `/sobjects/Contact/<id>`.
// So a trailing-slash tool needs no slashless alias. An alias is only needed
// for a pattern with no `*` before its end (exact or raw-prefix regime).
const HOST = "*.my.salesforce.com";

export const salesforcePermissions: AppPermissionDefinition = {
  provider: "salesforce",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_versions",
          name: "List API versions",
          description: "Discover the REST API versions this org supports",
          hostPattern: HOST,
          // No wildcard, so both spellings are exact and safe.
          pathPattern: "/services/data/",
          aliasPatterns: ["/services/data"],
          method: "GET",
        },
        {
          id: "list_resources",
          name: "List API resources",
          description: "List the REST resources available in a version",
          hostPattern: HOST,
          // Terminal wildcard segment: the trailing slash is what keeps this
          // from becoming a raw prefix over the whole version. No alias.
          pathPattern: "/services/data/v*/",
          method: "GET",
        },
        {
          id: "list_objects",
          name: "List objects",
          description: "List the CRM objects available in this org",
          hostPattern: HOST,
          // Wildcard is mid-path, so the segment matcher pins depth in both
          // spellings and the slashless alias is safe.
          pathPattern: "/services/data/v*/sobjects/",
          aliasPatterns: ["/services/data/v*/sobjects"],
          method: "GET",
        },
        {
          id: "describe_object",
          name: "Describe an object",
          description: "Read an object's fields, layouts, and relationships",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/sobjects/*/describe",
          method: "GET",
        },
        {
          id: "get_record",
          name: "Get a record",
          description: "Read a CRM record, or a single field of one, by ID",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/sobjects/*/*",
          method: "GET",
        },
        {
          id: "query",
          name: "Run a SOQL query",
          description: "Query CRM records with SOQL",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/query",
          aliasPatterns: ["/services/data/v*/query/"],
          method: "GET",
        },
        {
          id: "query_more",
          name: "Page through query results",
          description: "Fetch the next page of a SOQL query result",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/query/*",
          method: "GET",
        },
        {
          id: "query_all",
          name: "Query including deleted records",
          description:
            "Query CRM records including archived and deleted records",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/queryAll",
          aliasPatterns: ["/services/data/v*/queryAll/"],
          method: "GET",
        },
        {
          id: "query_all_more",
          name: "Page through queryAll results",
          description: "Fetch the next page of a queryAll result",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/queryAll/*",
          method: "GET",
        },
        {
          id: "search",
          name: "Search records",
          description: "Search CRM records with SOSL",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/search",
          aliasPatterns: ["/services/data/v*/search/"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_record",
          name: "Create a record",
          description: "Create a new CRM record",
          hostPattern: HOST,
          // Terminal wildcard (the object name), so the trailing slash pins
          // depth — matching Salesforce's documented create URL. Without it
          // this would also cover record-ID paths, where a `_HttpMethod`
          // override could turn a create grant into an update or delete.
          pathPattern: "/services/data/v*/sobjects/*/",
          method: "POST",
        },
        {
          id: "update_record",
          name: "Update a record",
          description: "Update or upsert an existing CRM record",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/sobjects/*/*",
          method: "PATCH",
        },
        {
          id: "delete_record",
          name: "Delete a record",
          description: "Delete a CRM record",
          hostPattern: HOST,
          pathPattern: "/services/data/v*/sobjects/*/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
