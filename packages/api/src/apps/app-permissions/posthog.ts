import type { AppPermissionDefinition, AppTool } from "./types";

// PostHog Cloud serves the REST API per region (plus the legacy US host
// app.posthog.com). Every tool answers on all of them. Paths verified against
// the live OpenAPI schema (https://us.posthog.com/api/schema/).
const HOST = "us.posthog.com";
const HOST_ALIASES = ["eu.posthog.com", "app.posthog.com"];

// PostHog paths end with "/" and nest resources under a project id.
const tool = (
  t: Omit<AppTool, "hostPattern" | "hostAliasPatterns">,
): AppTool => ({ ...t, hostPattern: HOST, hostAliasPatterns: HOST_ALIASES });

export const posthogPermissions: AppPermissionDefinition = {
  provider: "posthog",
  groups: [
    {
      category: "read",
      tools: [
        tool({
          id: "run_query",
          name: "Run query",
          description: "Run HogQL, trends, and funnel queries over events",
          pathPattern: "/api/projects/*/query/",
          aliasPatterns: ["/api/projects/*/query/*/"],
          methods: ["POST", "GET"],
        }),
        tool({
          id: "list_events",
          name: "List events",
          description: "Browse raw events",
          pathPattern: "/api/projects/*/events/",
          method: "GET",
        }),
        tool({
          id: "list_insights",
          name: "List insights",
          description: "List saved insights",
          pathPattern: "/api/projects/*/insights/",
          method: "GET",
        }),
        tool({
          id: "get_insight",
          name: "Get insight",
          description: "View a saved insight and its results",
          pathPattern: "/api/projects/*/insights/*/",
          method: "GET",
        }),
        tool({
          id: "list_dashboards",
          name: "List dashboards",
          description: "List dashboards",
          pathPattern: "/api/projects/*/dashboards/",
          aliasPatterns: ["/api/projects/*/dashboards/*/"],
          method: "GET",
        }),
        tool({
          id: "list_feature_flags",
          name: "List feature flags",
          description: "View feature flags and their rollout",
          pathPattern: "/api/projects/*/feature_flags/",
          aliasPatterns: ["/api/projects/*/feature_flags/*/"],
          method: "GET",
        }),
        tool({
          id: "list_experiments",
          name: "List experiments",
          description: "View experiments and results",
          pathPattern: "/api/projects/*/experiments/",
          aliasPatterns: ["/api/projects/*/experiments/*/"],
          method: "GET",
        }),
        tool({
          id: "list_surveys",
          name: "List surveys",
          description: "View surveys",
          pathPattern: "/api/projects/*/surveys/",
          aliasPatterns: ["/api/projects/*/surveys/*/"],
          method: "GET",
        }),
        tool({
          id: "list_persons",
          name: "List persons",
          description: "Look up persons and their properties",
          pathPattern: "/api/projects/*/persons/",
          aliasPatterns: ["/api/projects/*/persons/*/"],
          method: "GET",
        }),
        tool({
          id: "list_cohorts",
          name: "List cohorts",
          description: "View cohorts",
          pathPattern: "/api/projects/*/cohorts/",
          aliasPatterns: ["/api/projects/*/cohorts/*/"],
          method: "GET",
        }),
        tool({
          id: "list_session_recordings",
          name: "List session recordings",
          description: "View session replays",
          pathPattern: "/api/projects/*/session_recordings/",
          aliasPatterns: ["/api/projects/*/session_recordings/*/"],
          method: "GET",
        }),
        tool({
          id: "list_annotations",
          name: "List annotations",
          description: "View annotations",
          pathPattern: "/api/projects/*/annotations/",
          aliasPatterns: ["/api/projects/*/annotations/*/"],
          method: "GET",
        }),
        tool({
          id: "list_definitions",
          name: "List data definitions",
          description: "Event, property, and action definitions",
          pathPattern: "/api/projects/*/event_definitions/",
          aliasPatterns: [
            "/api/projects/*/property_definitions/",
            "/api/projects/*/actions/",
          ],
          method: "GET",
        }),
        tool({
          id: "list_error_issues",
          name: "List error tracking issues",
          description: "View error tracking issues",
          pathPattern: "/api/projects/*/error_tracking/issues/",
          method: "GET",
        }),
        tool({
          id: "list_projects",
          name: "List projects",
          description: "List organizations and their projects",
          pathPattern: "/api/organizations/*/projects/",
          aliasPatterns: ["/api/organizations/", "/api/organizations/*/"],
          method: "GET",
        }),
        // Every project-scoped tool above needs a project id. `@current`
        // resolves to the key's default project, which is how agents and
        // SDKs discover it without an org id first.
        tool({
          id: "get_project",
          name: "Get project",
          description: "View a project's settings (including @current)",
          pathPattern: "/api/projects/*/",
          method: "GET",
        }),
        tool({
          id: "get_current_user",
          name: "Get current user",
          description: "View the connected user and current project",
          pathPattern: "/api/users/@me/",
          method: "GET",
        }),
      ],
    },
    {
      category: "write",
      tools: [
        tool({
          id: "create_insight",
          name: "Create insight",
          description: "Save a new insight",
          pathPattern: "/api/projects/*/insights/",
          method: "POST",
        }),
        tool({
          id: "update_insight",
          name: "Update insight",
          description: "Edit or delete a saved insight",
          pathPattern: "/api/projects/*/insights/*/",
          methods: ["PATCH", "PUT", "DELETE"],
        }),
        tool({
          id: "create_dashboard",
          name: "Create dashboard",
          description: "Create a dashboard",
          pathPattern: "/api/projects/*/dashboards/",
          method: "POST",
        }),
        tool({
          id: "update_dashboard",
          name: "Update dashboard",
          description: "Edit or delete a dashboard",
          pathPattern: "/api/projects/*/dashboards/*/",
          methods: ["PATCH", "PUT", "DELETE"],
        }),
        tool({
          id: "create_feature_flag",
          name: "Create feature flag",
          description: "Create a feature flag",
          pathPattern: "/api/projects/*/feature_flags/",
          method: "POST",
        }),
        tool({
          id: "update_feature_flag",
          name: "Update feature flag",
          description: "Change rollout, conditions, or delete a flag",
          pathPattern: "/api/projects/*/feature_flags/*/",
          methods: ["PATCH", "PUT", "DELETE"],
        }),
        tool({
          id: "create_annotation",
          name: "Create annotation",
          description: "Add an annotation to charts",
          pathPattern: "/api/projects/*/annotations/",
          method: "POST",
        }),
      ],
    },
  ],
};
