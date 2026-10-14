import { describe, expect, it } from "vitest";
import { webflow } from "../webflow";
import { webflowPermissions } from "./webflow";
import { allGroupTools } from "./types";
import { pathMatches } from "../../lib/path-match";

// Pins the Webflow catalog to the Data API v2 reference and to the paths the
// official `webflow-api` SDK emits. A tool here is what an allow/deny grant
// binds to, so each documented endpoint must land on exactly the tool whose
// name describes it, in the category its method implies.

const tools = webflowPermissions.groups.flatMap((group) =>
  allGroupTools(group).map((tool) => ({
    id: tool.id,
    category: group.category,
    methods: tool.methods ?? (tool.method ? [tool.method] : []),
    patterns: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
  })),
);

const matchingTools = (method: string, path: string): string[] =>
  tools
    .filter(
      (tool) =>
        tool.methods.includes(method) &&
        tool.patterns.some((pattern) => pathMatches(path, pattern)),
    )
    .map((tool) => tool.id);

describe("every documented endpoint resolves to its tool", () => {
  it.each([
    // Token
    ["GET", "/v2/token/authorized_by", "get_authorized_user"],
    ["GET", "/v2/token/introspect", "get_authorized_user"],
    // Sites
    ["GET", "/v2/sites", "list_sites"],
    ["GET", "/v2/sites/s1", "get_site"],
    ["GET", "/v2/sites/s1/custom_domains", "get_site"],
    ["POST", "/v2/sites/s1/publish", "publish_site"],
    // Pages and components
    ["GET", "/v2/sites/s1/pages", "list_pages"],
    ["GET", "/v2/pages/p1", "get_page"],
    ["GET", "/v2/pages/p1/dom", "get_page"],
    ["PUT", "/v2/pages/p1", "update_page_settings"],
    ["POST", "/v2/pages/p1/dom", "update_page_content"],
    ["GET", "/v2/sites/s1/components", "list_components"],
    ["GET", "/v2/sites/s1/components/c1/dom", "get_component"],
    ["GET", "/v2/sites/s1/components/c1/properties", "get_component"],
    ["POST", "/v2/sites/s1/components/c1/dom", "update_component"],
    ["POST", "/v2/sites/s1/components/c1/properties", "update_component"],
    // CMS collections and fields
    ["GET", "/v2/sites/s1/collections", "list_collections"],
    ["POST", "/v2/sites/s1/collections", "create_collection"],
    ["GET", "/v2/collections/c1", "get_collection"],
    ["PATCH", "/v2/collections/c1", "update_collection"],
    ["DELETE", "/v2/collections/c1", "delete_collection"],
    ["POST", "/v2/collections/c1/fields", "create_collection_field"],
    ["PATCH", "/v2/collections/c1/fields/f1", "update_collection"],
    ["DELETE", "/v2/collections/c1/fields/f1", "delete_collection"],
    // CMS items: the current create endpoint, the two older ones Webflow
    // still serves (and the SDK still calls), and the live variant
    ["POST", "/v2/collections/c1/items/insert", "create_items"],
    ["POST", "/v2/collections/c1/items", "create_items"],
    ["POST", "/v2/collections/c1/items/bulk", "create_items"],
    ["POST", "/v2/collections/c1/items/live", "create_items"],
    ["POST", "/v2/collections/c1/items/publish", "publish_items"],
    ["GET", "/v2/collections/c1/items", "list_items"],
    ["PATCH", "/v2/collections/c1/items", "update_items"],
    ["DELETE", "/v2/collections/c1/items", "delete_items"],
    ["PATCH", "/v2/collections/c1/items/live", "update_items"],
    ["DELETE", "/v2/collections/c1/items/live", "delete_items"],
    // CMS items addressed one at a time (the SDK's updateItem / deleteItem)
    ["GET", "/v2/collections/c1/items/i1", "get_item"],
    ["GET", "/v2/collections/c1/items/i1/live", "get_item"],
    ["PATCH", "/v2/collections/c1/items/i1", "update_items"],
    ["DELETE", "/v2/collections/c1/items/i1", "delete_items"],
    ["PATCH", "/v2/collections/c1/items/i1/live", "update_items"],
    ["DELETE", "/v2/collections/c1/items/i1/live", "delete_items"],
    // Forms, in both the site-scoped and the SDK's site-less spelling
    ["GET", "/v2/sites/s1/forms", "list_forms"],
    ["GET", "/v2/forms/f1", "get_form"],
    ["GET", "/v2/sites/s1/form_submissions", "list_form_submissions"],
    ["GET", "/v2/sites/s1/forms/f1/submissions", "list_form_submissions"],
    ["GET", "/v2/forms/f1/submissions", "list_form_submissions"],
    ["GET", "/v2/sites/s1/form_submissions/fs1", "get_form_submission"],
    ["GET", "/v2/form_submissions/fs1", "get_form_submission"],
    ["PATCH", "/v2/sites/s1/form_submissions/fs1", "update_form_submission"],
    ["PATCH", "/v2/form_submissions/fs1", "update_form_submission"],
    ["DELETE", "/v2/sites/s1/form_submissions/fs1", "delete_form_submission"],
    ["DELETE", "/v2/form_submissions/fs1", "delete_form_submission"],
    // Assets and folders
    ["GET", "/v2/sites/s1/assets", "list_assets"],
    ["GET", "/v2/sites/s1/asset_folders", "list_assets"],
    ["GET", "/v2/assets/a1", "get_asset"],
    ["GET", "/v2/asset_folders/af1", "get_asset"],
    ["POST", "/v2/sites/s1/assets", "upload_asset"],
    ["POST", "/v2/sites/s1/asset_folders", "upload_asset"],
    ["PATCH", "/v2/assets/a1", "update_asset"],
    ["DELETE", "/v2/assets/a1", "delete_asset"],
    // Comments
    ["GET", "/v2/sites/s1/comments", "list_comments"],
    ["GET", "/v2/sites/s1/comments/t1", "list_comments"],
    ["GET", "/v2/sites/s1/comments/t1/replies", "list_comments"],
    // Site activity and configuration (Enterprise workspaces)
    ["GET", "/v2/sites/s1/activity_logs", "get_site_activity"],
    ["GET", "/v2/sites/s1/robots_txt", "get_robots_txt"],
    ["PUT", "/v2/sites/s1/robots_txt", "update_robots_txt"],
    ["PATCH", "/v2/sites/s1/robots_txt", "update_robots_txt"],
    ["PUT", "/v2/sites/s1/well_known", "set_well_known_file"],
    ["DELETE", "/v2/sites/s1/robots_txt", "delete_site_config"],
    ["DELETE", "/v2/sites/s1/well_known", "delete_site_config"],
  ])("%s %s -> %s", (method, path, expected) => {
    expect(matchingTools(method, path)).toContain(expected);
  });

  // Tools share a request only where two reads describe the same shape: the
  // live-items listing (`/items/live`) also fits the single-staged-item
  // pattern (`/items/<id>`). Both are reads, so a grant on either never
  // changes what a write rule means. Any other overlap is a new finding.
  it("the only overlapping tools are the two reads on the live-items listing", () => {
    const overlaps = new Set(
      tools
        .flatMap((tool) =>
          tool.patterns.flatMap((pattern) =>
            tool.methods.map((method) => [method, pattern] as const),
          ),
        )
        .map(([method, pattern]) =>
          matchingTools(method, pattern.replace(/\*/g, "x")),
        )
        .filter((ids) => ids.length > 1)
        .map((ids) => ids.join("+")),
    );
    expect([...overlaps]).toEqual(["list_items+get_item"]);
  });
});

describe("collection-level tools never reach item paths", () => {
  it.each([
    ["GET", "/v2/collections/c1/items", "get_collection"],
    ["GET", "/v2/collections/c1/items/i1", "get_collection"],
    ["PATCH", "/v2/collections/c1/items", "update_collection"],
    ["PATCH", "/v2/collections/c1/items/i1", "update_collection"],
    ["DELETE", "/v2/collections/c1/items", "delete_collection"],
    ["DELETE", "/v2/collections/c1/items/i1", "delete_collection"],
    ["GET", "/v2/sites/s1/pages", "get_site"],
    ["GET", "/v2/pages/p1/dom", "update_page_settings"],
  ])("%s %s is not %s", (method, path, tool) => {
    expect(matchingTools(method, path)).not.toContain(tool);
  });
});

describe("surfaces outside the requested scopes stay outside every tool", () => {
  // Each needs a scope `webflow.ts` does not request (ecommerce, custom code,
  // users, workspace administration) or is site/workspace administration
  // the catalog deliberately leaves to the approval terminal.
  it.each([
    ["GET", "/v2/sites/s1/products"],
    ["POST", "/v2/sites/s1/products"],
    ["GET", "/v2/sites/s1/orders"],
    ["POST", "/v2/sites/s1/orders/o1/refund"],
    ["GET", "/v2/sites/s1/custom_code"],
    ["PUT", "/v2/pages/p1/custom_code"],
    ["POST", "/v2/sites/s1/registered_scripts/hosted"],
    ["GET", "/v2/sites/s1/webhooks"],
    ["POST", "/v2/sites/s1/webhooks"],
    ["DELETE", "/v2/webhooks/w1"],
    ["PATCH", "/v2/sites/s1"],
    ["DELETE", "/v2/sites/s1"],
    ["POST", "/v2/workspaces/w1/sites"],
    ["GET", "/v2/workspaces/w1/audit_logs"],
    ["POST", "/v2/sites/s1/redirects"],
    ["POST", "/v2/sites/s1/custom_fonts"],
    ["PATCH", "/v2/sites/s1/comments/t1"],
    ["POST", "/v2/sites/s1/comments/t1/replies"],
    // Webflow serves no PATCH for well-known files, so no tool claims one.
    ["PATCH", "/v2/sites/s1/well_known"],
  ])("no tool matches %s %s", (method, path) => {
    expect(matchingTools(method, path)).toEqual([]);
  });
});

describe("the catalog and the OAuth scopes describe the same surface", () => {
  // Every scope the app requests has at least one tool that needs it, and no
  // tool needs a scope the app does not request. The Webflow docs say to
  // request only what the app uses; this keeps the two lists honest.
  const scopeOf: Record<string, string> = {
    get_authorized_user: "authorized_user:read",
    list_sites: "sites:read",
    get_site: "sites:read",
    publish_site: "sites:write",
    list_pages: "pages:read",
    get_page: "pages:read",
    update_page_settings: "pages:write",
    update_page_content: "pages:write",
    list_components: "components:read",
    get_component: "components:read",
    update_component: "components:write",
    list_collections: "cms:read",
    get_collection: "cms:read",
    list_items: "cms:read",
    get_item: "cms:read",
    create_collection: "cms:write",
    update_collection: "cms:write",
    create_collection_field: "cms:write",
    delete_collection: "cms:write",
    create_items: "cms:write",
    update_items: "cms:write",
    publish_items: "cms:write",
    delete_items: "cms:write",
    list_forms: "forms:read",
    get_form: "forms:read",
    list_form_submissions: "forms:read",
    get_form_submission: "forms:read",
    update_form_submission: "forms:write",
    delete_form_submission: "forms:write",
    list_assets: "assets:read",
    get_asset: "assets:read",
    upload_asset: "assets:write",
    update_asset: "assets:write",
    delete_asset: "assets:write",
    list_comments: "comments:read",
    get_site_activity: "site_activity:read",
    get_robots_txt: "site_config:read",
    update_robots_txt: "site_config:write",
    set_well_known_file: "site_config:write",
    delete_site_config: "site_config:write",
  };

  it("every tool is assigned a scope", () => {
    expect(tools.map((tool) => tool.id).sort()).toEqual(
      Object.keys(scopeOf).sort(),
    );
  });

  it("requested scopes equal the scopes the tools need", () => {
    const method = webflow.connectionMethod;
    if (method.type !== "oauth") throw new Error("expected OAuth");
    expect([...(method.defaultScopes ?? [])].sort()).toEqual(
      [...new Set(Object.values(scopeOf))].sort(),
    );
  });
});
