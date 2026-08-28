import { afterEach, describe, expect, it, vi } from "vitest";

// The legacy last resort: lib/env.ts's defaulted APP_URL. Pinned here so the
// tests below assert against a known value rather than the ambient environment.
vi.mock("./env", () => ({ APP_URL: "http://localhost:10254" }));

import { dashboardUrl } from "./dashboard-url";

describe("dashboardUrl", () => {
  const orig = {
    APP_URL: process.env.APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  afterEach(() => {
    for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
  });

  const unconfigured = () => {
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  };

  it("prefers a configured APP_URL over the caller's fallback origin", () => {
    process.env.APP_URL = "https://onecli.example.com";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(dashboardUrl("/connections", undefined, "https://api.example")).toBe(
      "https://onecli.example.com/connections",
    );
  });

  // The bug this change fixes: an unconfigured self-hosted instance used to
  // hand out localhost links even though it knew the caller's real origin.
  it("uses the fallback origin when APP_URL is unconfigured", () => {
    unconfigured();
    expect(dashboardUrl("/connections", undefined, "https://box.example")).toBe(
      "https://box.example/connections",
    );
  });

  it("falls back to the legacy default when there is no request in scope", () => {
    unconfigured();
    expect(dashboardUrl("/connections")).toBe(
      "http://localhost:10254/connections",
    );
  });

  it("keeps the workspace- and org-scoped path shapes", () => {
    unconfigured();
    expect(
      dashboardUrl(
        "/connections",
        { workspaceId: "p1" },
        "https://box.example",
      ),
    ).toBe("https://box.example/w/p1/connections");
    expect(
      dashboardUrl("/billing", { organizationId: "o1" }, "https://box.example"),
    ).toBe("https://box.example/org/o1/billing");
  });
});
