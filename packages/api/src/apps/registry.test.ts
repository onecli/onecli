import { describe, expect, it } from "vitest";
import { getApps } from "./registry";

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
  "slack",
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
