import { describe, expect, it } from "vitest";
import { getApp, getApps } from "./registry";

describe("registry: microsoft-365", () => {
  it("exposes an available microsoft-365 OAuth app", () => {
    const app = getApp("microsoft-365");
    expect(app).toBeDefined();
    expect(app!.available).toBe(true);
    expect(app!.name).toBe("Microsoft 365");
    expect(app!.connectionMethod.type).toBe("oauth");
    if (app!.connectionMethod.type === "oauth") {
      expect(app!.connectionMethod.defaultScopes).toContain("offline_access");
      expect(app!.connectionMethod.defaultScopes).toContain("Mail.ReadWrite");
      expect(app!.connectionMethod.defaultScopes).toContain(
        "Calendars.ReadWrite",
      );
    }
    expect(app!.configurable?.envDefaults).toEqual({
      clientId: "MICROSOFT_CLIENT_ID",
      clientSecret: "MICROSOFT_CLIENT_SECRET",
    });
    expect(app!.teamOnly).toBeUndefined();
  });

  it("no longer lists the outlook placeholder cards", () => {
    const ids = getApps().map((a) => a.id);
    expect(ids).not.toContain("outlook-mail");
    expect(ids).not.toContain("outlook-calendar");
  });
});
