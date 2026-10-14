import type { AppPermissionDefinition, AppTool } from "./types";

// Coralogix APIs (coralogix.com/docs/api-reference), paths from the v5
// OpenAPI at `api.<domain>/mgmt/openapi/5/openapi.yaml`, plus the DataPrime
// and PromQL query endpoints documented beside it.
//
// Hosts: every region answers on `api.<region>.coralogix.com`. Older names
// still serve the same APIs and are what many existing scripts call:
// `ng-api-http.<domain>`, and the legacy per-region domains (`coralogix.us`,
// `cx498.coralogix.com`, `coralogix.com`, `coralogix.in`, `coralogixsg.com`).
// Every tool answers on all of them, mirroring the gateway's host rules, and
// the gateway pins the actual upstream to the connection's own region (see
// the host rewrite).
//
// Management paths sit under `/mgmt/openapi/<version>/` (`5`, or `latest`),
// so the version is a one-segment `*`. Single-item paths end in `*/`: one
// segment exactly, never deeper.
//
// Several Coralogix "list" endpoints are POSTs with a filter body (DataPrime,
// PromQL, incidents, cases). They are READS, and each is pinned to its exact
// path, so a write rule on the sibling `/all/...` action routes never covers
// them and vice versa.
const HOST = "api.*.coralogix.com";
const HOST_ALIASES = [
  "ng-api-http.*.coralogix.com",
  "api.coralogix.com",
  "ng-api-http.coralogix.com",
  "api.coralogix.us",
  "ng-api-http.coralogix.us",
  "api.coralogix.in",
  "ng-api-http.coralogix.in",
  "api.coralogixsg.com",
  "ng-api-http.coralogixsg.com",
];
const MGMT = "/mgmt/openapi/*";

const tool = (
  id: string,
  name: string,
  description: string,
  pathPattern: string,
  methods: string[],
  aliasPatterns?: string[],
): AppTool => ({
  id,
  name,
  description,
  hostPattern: HOST,
  hostAliasPatterns: HOST_ALIASES,
  pathPattern,
  ...(aliasPatterns ? { aliasPatterns } : {}),
  ...(methods.length === 1 ? { method: methods[0] } : { methods }),
});

export const coralogixPermissions: AppPermissionDefinition = {
  provider: "coralogix",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "query_logs",
          "Query logs and traces",
          "Run a DataPrime or Lucene query over logs and spans",
          "/api/v1/dataprime/query",
          ["POST"],
        ),
        tool(
          "query_metrics",
          "Query metrics",
          "Run PromQL queries and read metric labels and series",
          "/metrics/api/v1/*",
          ["GET", "POST"],
        ),
        tool(
          "whoami",
          "Read key identity",
          "See which team the API key belongs to",
          `${MGMT}/aaa/identity/v1/whoami`,
          ["GET"],
        ),
        tool(
          "list_alerts",
          "List alert definitions",
          "List alert definitions and read one",
          `${MGMT}/alerts/alerts/v3`,
          ["GET"],
          [
            `${MGMT}/alerts/alerts/v3/*/`,
            `${MGMT}/alerts/alerts/v3/all/*`,
            `${MGMT}/alerts/alerts/v3/version-ids/*/`,
          ],
        ),
        tool(
          "list_alert_events",
          "List alert events",
          "List triggered alert events, their counts and statistics",
          `${MGMT}/alerts/events/v3`,
          ["GET"],
          [`${MGMT}/alerts/events/v3/*/`, `${MGMT}/alerts/events/v3/all/*`],
        ),
        tool(
          "list_incidents",
          "List incidents",
          "List and filter incidents, read one, and its events",
          `${MGMT}/incidents/incidents/v1`,
          ["GET"],
          [
            `${MGMT}/incidents/incidents/v1/*/`,
            `${MGMT}/incidents/incidents/v1/*/events`,
            `${MGMT}/incidents/events/v1`,
            `${MGMT}/incidents/events/v1/*/`,
            `${MGMT}/incidents/events/v1/all/count`,
          ],
        ),
        // Listing with filters is a POST on the collection itself.
        tool(
          "filter_incidents",
          "Filter incidents",
          "List incidents matching a filter",
          `${MGMT}/incidents/incidents/v1`,
          ["POST"],
        ),
        tool(
          "list_cases",
          "List cases",
          "Read one case and its timeline",
          `${MGMT}/cases/cases/v1/*/`,
          ["GET"],
          [`${MGMT}/cases/cases/v1/*/events`, `${MGMT}/cases/events/v1/*/`],
        ),
        tool(
          "filter_cases",
          "Filter cases",
          "List cases matching a filter",
          `${MGMT}/cases/cases/v1`,
          ["POST"],
        ),
        tool(
          "list_dashboards",
          "List dashboards",
          "List dashboards and read one",
          `${MGMT}/dashboards/dashboards/v1/catalog/list`,
          ["GET"],
          [
            `${MGMT}/dashboards/dashboards/v1/*/`,
            `${MGMT}/dashboards/folders/v1`,
          ],
        ),
        tool(
          "list_slos",
          "List SLOs",
          "List SLOs, read one, and its status",
          `${MGMT}/slo/slos/v1`,
          ["GET"],
          [`${MGMT}/slo/slos/v1/*/`, `${MGMT}/slo/slos/v1/*/status`],
        ),
        tool(
          "list_views",
          "List saved views",
          "List saved Explore views and read one",
          `${MGMT}/data-exploration/views/v1/views`,
          ["GET"],
          [`${MGMT}/data-exploration/views/v1/views/*/`],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "update_incidents",
          "Acknowledge or resolve incidents",
          "Acknowledge, resolve, close, or assign incidents",
          `${MGMT}/incidents/incidents/v1/all/*`,
          ["POST", "DELETE"],
          [
            `${MGMT}/incidents/events/v1/*/acknowledge`,
            `${MGMT}/incidents/events/v1/*/resolve`,
          ],
        ),
        tool(
          "update_cases",
          "Update cases",
          "Update case fields, acknowledge, assign, resolve, close, or comment on cases",
          `${MGMT}/cases/cases/v1/*/comments`,
          ["POST", "PUT", "DELETE"],
          [
            `${MGMT}/cases/cases/v1/*/`,
            `${MGMT}/cases/acknowledged/v1`,
            `${MGMT}/cases/acknowledged/v1/*/`,
            `${MGMT}/cases/assigned/v1`,
            `${MGMT}/cases/assigned/v1/*/`,
            `${MGMT}/cases/resolved/v1`,
            `${MGMT}/cases/resolved/v1/*/`,
            `${MGMT}/cases/closed/v1`,
            `${MGMT}/cases/closed/v1/*/`,
            `${MGMT}/cases/events/v1/*/comments`,
          ],
        ),
        tool(
          "manage_alerts",
          "Manage alert definitions",
          "Create, replace, or delete alert definitions",
          `${MGMT}/alerts/alerts/v3`,
          ["POST", "PUT"],
          [`${MGMT}/alerts/alerts/v3/all/*`],
        ),
        tool(
          "delete_alert",
          "Delete alert definition",
          "Delete one alert definition",
          `${MGMT}/alerts/alerts/v3/*/`,
          ["DELETE"],
        ),
        tool(
          "manage_dashboards",
          "Manage dashboards",
          "Create, replace, move, or delete dashboards",
          `${MGMT}/dashboards/dashboards/v1`,
          ["POST", "PUT"],
          [
            `${MGMT}/dashboards/dashboards/v1/*/default`,
            `${MGMT}/dashboards/dashboards/v1/*/folder`,
          ],
        ),
        tool(
          "delete_dashboard",
          "Delete dashboard",
          "Delete one dashboard",
          `${MGMT}/dashboards/dashboards/v1/*/`,
          ["DELETE"],
        ),
      ],
    },
  ],
};
