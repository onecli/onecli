import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getApp, getApps } from "../registry";
import { OAUTH_CLIENT_GROUP_IDS } from "../types";
import {
  authorizeScopesFor,
  configKeyFor,
  configKeysFor,
  credentialsScopeNote,
  expandConfigKeys,
  groupMembers,
  providersForConfigKey,
  redirectPathFor,
  signedRedirectPath,
  vendorSetupGuideFor,
} from "./groups";

describe("vendor OAuth client groups", () => {
  it("groups every app that shares a vendor OAuth client", () => {
    expect(groupMembers("google")).toHaveLength(17);
    expect(groupMembers("atlassian").sort()).toEqual(["confluence", "jira"]);
    expect(groupMembers("microsoft")).toHaveLength(4);
  });

  it("keeps vertex-ai (credentials import, no BYOC client) out of the Google group", () => {
    expect(groupMembers("google")).not.toContain("vertex-ai");
  });

  it("saves under the group key, accepting an app id or the group id", () => {
    expect(configKeyFor("gmail")).toBe("google");
    expect(configKeyFor("google-drive")).toBe("google");
    expect(configKeyFor("google")).toBe("google");
    expect(configKeyFor("jira")).toBe("atlassian");
    expect(configKeyFor("github")).toBe("github");
  });

  it("reads the legacy per-app row before the group row", () => {
    const gmail = getApps().find((a) => a.id === "gmail")!;
    const github = getApps().find((a) => a.id === "github")!;
    expect(configKeysFor(gmail)).toEqual(["gmail", "google"]);
    expect(configKeysFor(github)).toEqual(["github"]);
  });

  it("expands a group key to its member apps", () => {
    expect(providersForConfigKey("atlassian").sort()).toEqual([
      "confluence",
      "jira",
    ]);
    expect(providersForConfigKey("github")).toEqual(["github"]);
    expect(expandConfigKeys(["atlassian", "jira", "github"]).sort()).toEqual([
      "confluence",
      "github",
      "jira",
    ]);
  });

  it("only groups apps whose fields match (one client shape per group)", () => {
    for (const group of OAUTH_CLIENT_GROUP_IDS) {
      const shapes = new Set(
        getApps()
          .filter((a) => a.configurable?.group === group)
          .map((a) => a.configurable!.fields.map((f) => f.name).join(",")),
      );
      expect(shapes.size, group).toBe(1);
    }
  });

  it("uses the vendor callback only for a vendor-shared client", () => {
    expect(redirectPathFor("gmail", "google")).toBe(
      "/v1/apps/oauth/google/callback",
    );
    // Legacy per-app row and platform (env) client keep the per-app path.
    expect(redirectPathFor("gmail", "gmail")).toBe("/v1/apps/gmail/callback");
    expect(redirectPathFor("gmail", undefined)).toBe("/v1/apps/gmail/callback");
    // A state minted before vendor callbacks existed used the per-app path.
    expect(signedRedirectPath({}, "jira")).toBe("/v1/apps/jira/callback");
    expect(
      signedRedirectPath(
        { redirectPath: "/v1/apps/oauth/atlassian/callback" },
        "jira",
      ),
    ).toBe("/v1/apps/oauth/atlassian/callback");
  });

  // Atlassian keeps ONE grant per user per 3LO app and a new consent replaces
  // its scopes: connecting Confluence through the shared app must also ask
  // for Jira's scopes, or it would strip the same user's Jira access.
  it("asks a shared Atlassian client for every Atlassian app's scopes", () => {
    const jira = getApp("jira")!;
    const confluence = getApp("confluence")!;
    const ownScopes = (id: string) => {
      const method = getApp(id)!.connectionMethod;
      return method.type === "oauth" ? (method.defaultScopes ?? []) : [];
    };
    const both = new Set([...ownScopes("jira"), ...ownScopes("confluence")]);

    for (const app of [jira, confluence]) {
      const shared = authorizeScopesFor(app, "atlassian");
      expect(new Set(shared), app.id).toEqual(both);
      expect(shared, app.id).toHaveLength(both.size);
    }
    // Per-app (legacy or platform) Atlassian clients keep the app's own.
    expect(authorizeScopesFor(jira, "jira")).toEqual(ownScopes("jira"));
    expect(authorizeScopesFor(confluence, undefined)).toEqual(
      ownScopes("confluence"),
    );
    // Other vendors' shared clients are per-app consents: unchanged.
    expect(authorizeScopesFor(getApp("gmail")!, "google")).toEqual(
      ownScopes("gmail"),
    );
  });

  it("links the vendor's guide only where the vendor has one", () => {
    expect(vendorSetupGuideFor("google-drive")).toEqual({
      name: "Google",
      url: "https://onecli.sh/docs/integrations/google",
    });
    expect(vendorSetupGuideFor("jira")).toBeNull();
    expect(vendorSetupGuideFor("github")).toBeNull();
  });

  it("spells out where a save lands, vendor-wide for a grouped app", () => {
    expect(credentialsScopeNote("gmail", "organization")).toMatch(
      /^One Google client for all Google apps \(.+\) in every workspace in your organization\.$/,
    );
    expect(credentialsScopeNote("jira", "workspace")).toBe(
      "One Atlassian client for all Atlassian apps (Jira, Confluence) in this workspace (overrides your organization's client).",
    );
    expect(credentialsScopeNote("github", "workspace")).toBe(
      "Applies to this workspace (overrides your organization's client).",
    );
  });

  // The gateway resolves BYOC credentials on refresh with its own copy of the
  // group map; a drift would make refresh silently fall back to platform
  // credentials for the drifted app. MUTATION-PROOF: add/remove a member on
  // either side and this fails.
  it("matches the gateway's OAUTH_CLIENT_GROUPS", () => {
    const rust = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../../apps/gateway/crates/apps/src/lib.rs",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const block = rust.match(
      /pub static OAUTH_CLIENT_GROUPS[^=]*= &\[([\s\S]*?)\n\];/,
    )?.[1];
    expect(block).toBeDefined();
    const rustGroups: Record<string, string[]> = {};
    for (const m of block!.matchAll(/"([a-z]+)",\s*&\[([^\]]*)\]/g)) {
      rustGroups[m[1]!] = [...m[2]!.matchAll(/"([^"]+)"/g)]
        .map((x) => x[1]!)
        .sort();
    }
    const tsGroups = Object.fromEntries(
      OAUTH_CLIENT_GROUP_IDS.map((g) => [g, [...groupMembers(g)].sort()]),
    );
    expect(rustGroups).toEqual(tsGroups);
  });
});
