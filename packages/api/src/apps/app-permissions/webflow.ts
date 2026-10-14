import type { AppPermissionDefinition, AppTool } from "./types";

// Webflow Data API v2. Every path below was taken from the endpoint's page in
// the official reference (developers.webflow.com/data/reference/...) and
// cross-checked against the paths the official `webflow-api` SDK emits, so
// an agent using the SDK lands on the same tools as one calling the REST
// paths by hand (`webflow.test.ts` pins both spellings).
//
// Path pattern discipline (see `salesforce.ts` for the full rationale): a
// pattern whose ONLY `*` is its last character is a RAW PREFIX, so
// `/v2/collections/*` would swallow `/v2/collections/<id>/items/...`. A tool
// whose final segment is a wildcard is therefore written with a trailing
// slash, which forces the segment matcher and pins depth. Patterns with an
// earlier `*` are already depth-pinned.
//
// Scope is exactly what the OAuth app requests (`webflow.ts` defaultScopes):
// sites, pages, components, CMS, forms, assets, comments (read), site
// activity and site configuration. Ecommerce, custom code, custom fonts,
// webhooks, redirects and workspace/site administration need scopes OneCLI
// does not ask for, so they are absent and land on the approval terminal.
const HOST = "api.webflow.com";

const tool = (t: Omit<AppTool, "hostPattern">): AppTool => ({
  ...t,
  hostPattern: HOST,
});

export const webflowPermissions: AppPermissionDefinition = {
  provider: "webflow",
  groups: [
    {
      category: "read",
      tools: [
        tool({
          id: "get_authorized_user",
          name: "Get authorized user",
          description:
            "See which Webflow user authorized the connection and what it can access",
          pathPattern: "/v2/token/authorized_by",
          aliasPatterns: ["/v2/token/introspect"],
          method: "GET",
        }),
        tool({
          id: "list_sites",
          name: "List sites",
          description: "List the sites the connection can access",
          pathPattern: "/v2/sites",
          method: "GET",
        }),
        tool({
          id: "get_site",
          name: "Get site",
          description: "View a site and its custom domains",
          pathPattern: "/v2/sites/*/",
          aliasPatterns: ["/v2/sites/*/custom_domains"],
          method: "GET",
        }),
        tool({
          id: "list_pages",
          name: "List pages",
          description: "List a site's pages",
          pathPattern: "/v2/sites/*/pages",
          method: "GET",
        }),
        tool({
          id: "get_page",
          name: "Get page",
          description: "View a page's settings and content",
          pathPattern: "/v2/pages/*/",
          aliasPatterns: ["/v2/pages/*/dom"],
          method: "GET",
        }),
        tool({
          id: "list_components",
          name: "List components",
          description: "List a site's components",
          pathPattern: "/v2/sites/*/components",
          method: "GET",
        }),
        tool({
          id: "get_component",
          name: "Get component",
          description: "View a component's content and properties",
          pathPattern: "/v2/sites/*/components/*/dom",
          aliasPatterns: ["/v2/sites/*/components/*/properties"],
          method: "GET",
        }),
        tool({
          id: "list_collections",
          name: "List collections",
          description: "List a site's CMS collections",
          pathPattern: "/v2/sites/*/collections",
          method: "GET",
        }),
        tool({
          id: "get_collection",
          name: "Get collection",
          description: "View a collection and its fields",
          pathPattern: "/v2/collections/*/",
          method: "GET",
        }),
        tool({
          id: "list_items",
          name: "List items",
          description: "List staged and live items in a collection",
          pathPattern: "/v2/collections/*/items",
          aliasPatterns: ["/v2/collections/*/items/live"],
          method: "GET",
        }),
        tool({
          id: "get_item",
          name: "Get item",
          description: "View a staged or live collection item",
          pathPattern: "/v2/collections/*/items/*/",
          aliasPatterns: ["/v2/collections/*/items/*/live"],
          method: "GET",
        }),
        tool({
          id: "list_forms",
          name: "List forms",
          description: "List a site's forms",
          pathPattern: "/v2/sites/*/forms",
          method: "GET",
        }),
        tool({
          id: "get_form",
          name: "Get form",
          description: "View a form's schema",
          pathPattern: "/v2/forms/*/",
          method: "GET",
        }),
        // Form submissions answer on two spellings: the site-scoped routes in
        // the reference navigation and the site-less ones the official SDK
        // calls (`/v2/forms/*/submissions`, `/v2/form_submissions/*`).
        tool({
          id: "list_form_submissions",
          name: "List form submissions",
          description: "List submissions for a form or a whole site",
          pathPattern: "/v2/sites/*/form_submissions",
          aliasPatterns: [
            "/v2/sites/*/forms/*/submissions",
            "/v2/forms/*/submissions",
          ],
          method: "GET",
        }),
        tool({
          id: "get_form_submission",
          name: "Get form submission",
          description: "View a single form submission",
          pathPattern: "/v2/sites/*/form_submissions/*/",
          aliasPatterns: ["/v2/form_submissions/*/"],
          method: "GET",
        }),
        tool({
          id: "list_assets",
          name: "List assets",
          description: "List a site's assets and asset folders",
          pathPattern: "/v2/sites/*/assets",
          aliasPatterns: ["/v2/sites/*/asset_folders"],
          method: "GET",
        }),
        tool({
          id: "get_asset",
          name: "Get asset",
          description: "View an asset or asset folder",
          pathPattern: "/v2/assets/*/",
          aliasPatterns: ["/v2/asset_folders/*/"],
          method: "GET",
        }),
        tool({
          id: "list_comments",
          name: "List comments",
          description: "View a site's comment threads and their replies",
          pathPattern: "/v2/sites/*/comments",
          aliasPatterns: [
            "/v2/sites/*/comments/*/",
            "/v2/sites/*/comments/*/replies",
          ],
          method: "GET",
        }),
        // Enterprise-workspace endpoints: Webflow answers 403 elsewhere, so
        // the tools are inert on other plans.
        tool({
          id: "get_site_activity",
          name: "Get site activity",
          description: "View a site's activity log",
          pathPattern: "/v2/sites/*/activity_logs",
          method: "GET",
        }),
        tool({
          id: "get_robots_txt",
          name: "Get robots.txt",
          description: "View a site's robots.txt rules",
          pathPattern: "/v2/sites/*/robots_txt",
          method: "GET",
        }),
      ],
    },
    {
      category: "write",
      tools: [
        tool({
          id: "publish_site",
          name: "Publish site",
          description: "Publish a site to its domains",
          pathPattern: "/v2/sites/*/publish",
          method: "POST",
        }),
        tool({
          id: "update_page_settings",
          name: "Update page settings",
          description: "Change a page's title, slug, and SEO settings",
          pathPattern: "/v2/pages/*/",
          method: "PUT",
        }),
        tool({
          id: "update_page_content",
          name: "Update page content",
          description: "Edit the static text on a page",
          pathPattern: "/v2/pages/*/dom",
          method: "POST",
        }),
        tool({
          id: "update_component",
          name: "Update component",
          description: "Edit a component's content and properties",
          pathPattern: "/v2/sites/*/components/*/dom",
          aliasPatterns: ["/v2/sites/*/components/*/properties"],
          method: "POST",
        }),
        tool({
          id: "create_collection",
          name: "Create collection",
          description: "Create a new CMS collection",
          pathPattern: "/v2/sites/*/collections",
          method: "POST",
        }),
        tool({
          id: "update_collection",
          name: "Update collection",
          description: "Rename a collection or edit one of its fields",
          pathPattern: "/v2/collections/*/",
          aliasPatterns: ["/v2/collections/*/fields/*/"],
          method: "PATCH",
        }),
        tool({
          id: "create_collection_field",
          name: "Create collection field",
          description: "Add a field to a collection",
          pathPattern: "/v2/collections/*/fields",
          method: "POST",
        }),
        tool({
          id: "delete_collection",
          name: "Delete collection",
          description: "Delete a collection or one of its fields",
          pathPattern: "/v2/collections/*/",
          aliasPatterns: ["/v2/collections/*/fields/*/"],
          method: "DELETE",
        }),
        // `/items/insert` is the current create endpoint; `/items` and
        // `/items/bulk` are the older ones Webflow still serves and the SDK
        // still calls, so a create tool covers all three.
        tool({
          id: "create_items",
          name: "Create items",
          description: "Create staged or live collection items",
          pathPattern: "/v2/collections/*/items/insert",
          aliasPatterns: [
            "/v2/collections/*/items",
            "/v2/collections/*/items/bulk",
            "/v2/collections/*/items/live",
          ],
          method: "POST",
        }),
        // Item edits and deletes exist in bulk (`/items`, `/items/live`) and
        // single-item (`/items/<id>`, `/items/<id>/live`) form; one tool per
        // verb covers both so a grant means the same thing however the agent
        // addresses the item.
        tool({
          id: "update_items",
          name: "Update items",
          description: "Edit staged or live collection items",
          pathPattern: "/v2/collections/*/items",
          aliasPatterns: [
            "/v2/collections/*/items/live",
            "/v2/collections/*/items/*/",
            "/v2/collections/*/items/*/live",
          ],
          method: "PATCH",
        }),
        tool({
          id: "publish_items",
          name: "Publish items",
          description: "Publish staged collection items",
          pathPattern: "/v2/collections/*/items/publish",
          method: "POST",
        }),
        tool({
          id: "delete_items",
          name: "Delete items",
          description: "Delete staged items or unpublish live items",
          pathPattern: "/v2/collections/*/items",
          aliasPatterns: [
            "/v2/collections/*/items/live",
            "/v2/collections/*/items/*/",
            "/v2/collections/*/items/*/live",
          ],
          method: "DELETE",
        }),
        tool({
          id: "update_form_submission",
          name: "Update form submission",
          description: "Edit a form submission",
          pathPattern: "/v2/sites/*/form_submissions/*/",
          aliasPatterns: ["/v2/form_submissions/*/"],
          method: "PATCH",
        }),
        tool({
          id: "delete_form_submission",
          name: "Delete form submission",
          description: "Delete a form submission",
          pathPattern: "/v2/sites/*/form_submissions/*/",
          aliasPatterns: ["/v2/form_submissions/*/"],
          method: "DELETE",
        }),
        tool({
          id: "upload_asset",
          name: "Upload asset",
          description: "Upload an asset or create an asset folder",
          pathPattern: "/v2/sites/*/assets",
          aliasPatterns: ["/v2/sites/*/asset_folders"],
          method: "POST",
        }),
        tool({
          id: "update_asset",
          name: "Update asset",
          description: "Rename an asset or move it to a folder",
          pathPattern: "/v2/assets/*/",
          method: "PATCH",
        }),
        tool({
          id: "delete_asset",
          name: "Delete asset",
          description: "Delete an asset",
          pathPattern: "/v2/assets/*/",
          method: "DELETE",
        }),
        // Enterprise-workspace endpoints (see the read group). robots.txt is
        // replaced with PUT and merged with PATCH; a well-known file is set
        // with PUT only, so it gets its own tool rather than a PATCH that
        // Webflow does not serve.
        tool({
          id: "update_robots_txt",
          name: "Update robots.txt",
          description: "Replace or edit a site's robots.txt rules",
          pathPattern: "/v2/sites/*/robots_txt",
          methods: ["PUT", "PATCH"],
        }),
        tool({
          id: "set_well_known_file",
          name: "Set well-known file",
          description: "Set a site's well-known files, such as security.txt",
          pathPattern: "/v2/sites/*/well_known",
          method: "PUT",
        }),
        tool({
          id: "delete_site_config",
          name: "Delete site config",
          description: "Delete a site's robots.txt rules or well-known files",
          pathPattern: "/v2/sites/*/robots_txt",
          aliasPatterns: ["/v2/sites/*/well_known"],
          method: "DELETE",
        }),
      ],
    },
  ],
};
