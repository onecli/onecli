import type { AppPermissionDefinition, AppTool } from "./types";

// PagerDuty REST API v2 (docs.pagerduty.com/developer/api/reference), paths
// from PagerDuty's published OpenAPI (github.com/PagerDuty/api-schema). The
// same API is served from two regional hosts, so every tool answers on both:
// the gateway routes a connection to its own region (see the host rewrite).
//
// Single-item paths end in `*/`: one segment exactly (with or without the
// trailing slash), never deeper. `/incidents/*` would also match
// `/incidents/{id}/notes`, so "Get incident" would leak the notes route and
// "Update incident" would answer the merge route.
//
// The analytics endpoints take their filters in a POST body, so they are
// READS. Nothing else lives under /analytics/, so the separation between
// read and write holds on the path alone.
const HOST = "api.pagerduty.com";
const HOST_ALIASES = ["api.eu.pagerduty.com"];

const read = (
  id: string,
  name: string,
  description: string,
  pathPattern: string,
  aliasPatterns?: string[],
  methods: string[] = ["GET"],
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

const write = (
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

export const pagerdutyPermissions: AppPermissionDefinition = {
  provider: "pagerduty",
  groups: [
    {
      category: "read",
      tools: [
        read(
          "list_incidents",
          "List incidents",
          "List and filter incidents by status, service, team, or date",
          "/incidents",
        ),
        read(
          "get_incident",
          "Get incident",
          "Read one incident's details",
          "/incidents/*/",
        ),
        read(
          "list_incident_alerts",
          "List incident alerts",
          "Read the alerts grouped into an incident",
          "/incidents/*/alerts",
          ["/incidents/*/alerts/*/"],
        ),
        read(
          "list_incident_notes",
          "List incident notes",
          "Read the notes on an incident",
          "/incidents/*/notes",
        ),
        read(
          "list_incident_log_entries",
          "List incident timeline",
          "Read an incident's log entries (triggers, acknowledgements, escalations)",
          "/incidents/*/log_entries",
          ["/log_entries", "/log_entries/*/"],
        ),
        read(
          "list_incident_related",
          "Read related incidents",
          "Read related, past, and outlier incidents for an incident",
          "/incidents/*/related_incidents",
          ["/incidents/*/past_incidents", "/incidents/*/outlier_incident"],
        ),
        read(
          "list_services",
          "List services",
          "List services and read one service's settings",
          "/services",
          ["/services/*/"],
        ),
        read(
          "list_business_services",
          "List business services",
          "List business services and read one",
          "/business_services",
          ["/business_services/*/"],
        ),
        read(
          "list_escalation_policies",
          "List escalation policies",
          "List escalation policies and read one",
          "/escalation_policies",
          ["/escalation_policies/*/"],
        ),
        read(
          "list_schedules",
          "List schedules",
          "List on-call schedules, read one, its users, and its overrides",
          "/schedules",
          ["/schedules/*/", "/schedules/*/users", "/schedules/*/overrides"],
        ),
        read(
          "list_oncalls",
          "List on-calls",
          "See who is on call right now, or for a time range",
          "/oncalls",
        ),
        read(
          "list_users",
          "List users",
          "List users and read one user's profile",
          "/users",
          ["/users/*/"],
        ),
        read("list_teams", "List teams", "List teams and read one", "/teams", [
          "/teams/*/",
          "/teams/*/members",
        ]),
        read(
          "list_maintenance_windows",
          "List maintenance windows",
          "List maintenance windows and read one",
          "/maintenance_windows",
          ["/maintenance_windows/*/"],
        ),
        read(
          "list_change_events",
          "List change events",
          "List recent change events (deploys, config changes) and read one",
          "/change_events",
          ["/change_events/*/", "/services/*/change_events"],
        ),
        read(
          "list_priorities",
          "List priorities",
          "List the account's incident priorities",
          "/priorities",
        ),
        read(
          "list_abilities",
          "List abilities",
          "See which features the account has",
          "/abilities",
          ["/abilities/*/"],
        ),
        read(
          "read_analytics",
          "Read analytics",
          "Read aggregated and raw incident, service, team, and responder metrics",
          "/analytics/*",
          undefined,
          ["GET", "POST"],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        write(
          "create_incident",
          "Create incident",
          "Open a new incident on a service (pages the on-call)",
          "/incidents",
          ["POST"],
        ),
        write(
          "update_incident",
          "Update incident",
          "Acknowledge, resolve, reassign, escalate, or change the priority of incidents",
          "/incidents/*/",
          ["PUT"],
          ["/incidents"],
        ),
        write(
          "add_incident_note",
          "Add incident note",
          "Add a note to an incident's timeline",
          "/incidents/*/notes",
          ["POST"],
        ),
        write(
          "add_responders",
          "Add responders",
          "Request more responders on an incident (pages them)",
          "/incidents/*/responder_requests",
          ["POST"],
        ),
        write(
          "send_status_update",
          "Send status update",
          "Send a status update to an incident's subscribers",
          "/incidents/*/status_updates",
          ["POST"],
        ),
        write(
          "snooze_incident",
          "Snooze incident",
          "Snooze an acknowledged incident",
          "/incidents/*/snooze",
          ["POST"],
        ),
        write(
          "merge_incidents",
          "Merge incidents",
          "Merge other incidents into one",
          "/incidents/*/merge",
          ["PUT"],
        ),
        write(
          "manage_alerts",
          "Update incident alerts",
          "Resolve or move the alerts in an incident",
          "/incidents/*/alerts",
          ["PUT"],
          ["/incidents/*/alerts/*/"],
        ),
        write(
          "manage_maintenance_windows",
          "Manage maintenance windows",
          "Create, change, or delete maintenance windows (suppresses paging)",
          "/maintenance_windows",
          ["POST", "PUT", "DELETE"],
          ["/maintenance_windows/*/"],
        ),
        write(
          "manage_schedule_overrides",
          "Manage schedule overrides",
          "Add or remove on-call schedule overrides",
          "/schedules/*/overrides",
          ["POST", "DELETE"],
          ["/schedules/*/overrides/*/"],
        ),
        write(
          "manage_services",
          "Manage services",
          "Create, change, or delete services",
          "/services",
          ["POST", "PUT", "DELETE"],
          ["/services/*/"],
        ),
        write(
          "create_change_event",
          "Create change event",
          "Record a change event (e.g. a deploy)",
          "/change_events",
          ["POST"],
        ),
      ],
    },
  ],
};
