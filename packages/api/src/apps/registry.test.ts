import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getApp, getApps } from "./registry";
import { getAppPermissionDefinitions } from "./app-permissions/index";

// Apps are universal: the formerly-EE definitions live in the single static
// registry, in every edition, with real connection methods (the `cloud_only`
// teaser variant and the `available` flag no longer exist).
//
// zoho-crm joined the registry with the enterprise-licensing PR (user
// decision: every app is free on every plan and on self-host).
const FORMERLY_EE_APP_IDS = [
  "datadog",
  "outlook-mail",
  "outlook-calendar",
  "microsoft-word",
  "microsoft-onenote",
  "aws-role",
  "affinity",
  "zoom",
  "sentry",
  "hubspot",
  "granola",
  "linear",
  "attio",
  "x",
  "fathom",
  "fireflies",
  "zoho-crm",
] as const;

const REAL_CONNECTION_METHODS = new Set([
  "oauth",
  "api_key",
  "credentials_import",
]);

describe("unified app registry", () => {
  it("registers every formerly-EE app", () => {
    const ids = new Set(getApps().map((a) => a.id));
    const missing = FORMERLY_EE_APP_IDS.filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });

  it("every app has a real connection method (no cloud_only teasers)", () => {
    for (const app of getApps()) {
      expect(
        REAL_CONNECTION_METHODS.has(app.connectionMethod.type),
        `${app.id}: ${app.connectionMethod.type}`,
      ).toBe(true);
      for (const method of app.additionalMethods ?? []) {
        expect(
          REAL_CONNECTION_METHODS.has(method.type),
          `${app.id} (additional): ${method.type}`,
        ).toBe(true);
      }
    }
  });

  it("app ids are unique (merging the registries introduced no collisions)", () => {
    const ids = getApps().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Slack is a channel, not a gateway app (plans/channel-aware-agents.md)", () => {
  // An agent's Slack access is its own Slack app (agent_channels); the
  // gateway never injects Slack credentials. The registry is the one source
  // the dashboard's Apps tab, the connect picker, the permissions UI and the
  // gateway's embedded catalog all read, so its silence here is what keeps
  // "Connect Slack" out of every surface at once. The purge migration
  // (20260915002700) removed the rows the old app left behind; this pins
  // that the app itself never comes back by accident.
  // MUTATION-PROOF: re-register `slack` anywhere and one of these fails.
  it("is absent from the app registry", () => {
    expect(getApps().some((a) => a.id === "slack")).toBe(false);
    expect(getApp("slack")).toBeUndefined();
  });

  it("is absent from the permission definitions and the gateway's embedded catalog", () => {
    expect(
      getAppPermissionDefinitions().some((d) => d.provider === "slack"),
    ).toBe(false);
    const catalog = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../apps/gateway/crates/policy-engine/src/catalog.generated.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(catalog).not.toMatch(/"slack"/);
    expect(catalog).not.toMatch(/slack\.com/);
  });
});
