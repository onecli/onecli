import { beforeEach, describe, expect, it, vi } from "vitest";

// Vendor-grouped resolution: a client saved once for "google" serves every
// Google app; a workspace's own Google client overrides the org's for that
// workspace only; a legacy per-app row still wins within its scope. Exercises
// the real resolver + org resolver + service over a keyed in-memory AppConfig
// table.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

type Row = {
  id: string;
  settings: Record<string, string>;
  credentials: string | null;
  enabled: boolean;
};

const rows = vi.hoisted(() => new Map<string, Row>());

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    appConfig: {
      findUnique: async ({
        where,
      }: {
        where: {
          workspaceId_provider?: { workspaceId: string; provider: string };
          organizationId_provider?: {
            organizationId: string;
            provider: string;
          };
        };
      }) => {
        if (where.workspaceId_provider) {
          const k = where.workspaceId_provider;
          return rows.get(`ws:${k.workspaceId}:${k.provider}`) ?? null;
        }
        const k = where.organizationId_provider!;
        return rows.get(`org:${k.organizationId}:${k.provider}`) ?? null;
      },
    },
  },
}));

import { resolveAppCredentials } from "./resolve-credentials";
import { orgAppConfig } from "./org-app-config";
import { initOrgAppConfig } from "../providers";
import { getApp } from "./registry";

const row = (id: string, clientId: string): Row => ({
  id,
  settings: { clientId, clientSecret: `${clientId}-secret` },
  credentials: null,
  enabled: true,
});

const resolve = async (workspaceId: string, appId: string) =>
  resolveAppCredentials(workspaceId, getApp(appId)!, "org-1");

describe("vendor-grouped credential resolution", () => {
  beforeEach(() => {
    rows.clear();
    initOrgAppConfig(orgAppConfig);
  });

  it("an org Google client serves every Google app in every workspace", async () => {
    rows.set("org:org-1:google", row("org-google", "org-g"));
    for (const appId of ["gmail", "google-drive", "youtube"]) {
      for (const ws of ["ws-a", "ws-b"]) {
        const r = await resolve(ws, appId);
        expect(r?.values.clientId, `${ws}/${appId}`).toBe("org-g");
        expect(r?.appConfigId).toBe("org-google");
      }
    }
  });

  it("a workspace Google client overrides the org's for that workspace only", async () => {
    rows.set("org:org-1:google", row("org-google", "org-g"));
    rows.set("ws:ws-a:google", row("ws-a-google", "ws-a-g"));
    expect((await resolve("ws-a", "google-calendar"))?.values.clientId).toBe(
      "ws-a-g",
    );
    expect((await resolve("ws-a", "gmail"))?.values.clientId).toBe("ws-a-g");
    expect((await resolve("ws-b", "gmail"))?.values.clientId).toBe("org-g");
  });

  it("does not leak a vendor client across vendors", async () => {
    rows.set("org:org-1:google", row("org-google", "org-g"));
    vi.stubEnv("ATLASSIAN_CLIENT_ID", "");
    expect(await resolve("ws-a", "jira")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("an Atlassian client serves both Jira and Confluence", async () => {
    rows.set("org:org-1:atlassian", row("org-atl", "atl"));
    expect((await resolve("ws-a", "jira"))?.values.clientId).toBe("atl");
    expect((await resolve("ws-a", "confluence"))?.values.clientId).toBe("atl");
  });

  it("a legacy per-app row still wins within its scope", async () => {
    rows.set("ws:ws-a:google", row("ws-google", "ws-g"));
    rows.set("ws:ws-a:gmail", row("ws-gmail", "legacy-gmail"));
    expect((await resolve("ws-a", "gmail"))?.values.clientId).toBe(
      "legacy-gmail",
    );
    expect((await resolve("ws-a", "google-drive"))?.values.clientId).toBe(
      "ws-g",
    );
  });

  it("reports the org's Google client as configured for member apps", async () => {
    rows.set("org:org-1:google", {
      ...row("org-google", "org-g"),
      credentials: "enc",
    });
    expect(
      await orgAppConfig.getEnabledConfig("org-1", "google-sheets"),
    ).toEqual({ hasCredentials: true });
    expect(await orgAppConfig.getEnabledConfig("org-1", "jira")).toBeNull();
  });
});
