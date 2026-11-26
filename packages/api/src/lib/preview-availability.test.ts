import { describe, expect, it } from "vitest";
import { evaluatePreviewAvailability } from "./preview-availability";

const secret = "s".repeat(32);

describe("evaluatePreviewAvailability", () => {
  it("is dark until both the domain and the secret are set", () => {
    expect(evaluatePreviewAvailability({ domain: "", secret })).toEqual({
      enabled: false,
      reason: "unconfigured",
    });
    expect(
      evaluatePreviewAvailability({ domain: "previews.test", secret: "" }),
    ).toEqual({ enabled: false, reason: "unconfigured" });
  });

  it("refuses a short relay secret", () => {
    expect(
      evaluatePreviewAvailability({ domain: "previews.test", secret: "short" }),
    ).toEqual({ enabled: false, reason: "weak_secret" });
  });

  it("refuses when the dashboard address is unknown (the shared-site check could not run)", () => {
    expect(
      evaluatePreviewAvailability({ domain: "previews.test", secret }),
    ).toEqual({ enabled: false, reason: "no_dashboard_url" });
  });

  it("refuses a preview domain that shares a site with the dashboard or api (login-cookie exposure)", () => {
    for (const domain of ["preview.example.com", "example.com"]) {
      expect(
        evaluatePreviewAvailability({
          domain,
          secret,
          appUrl: "https://app.example.com",
          apiUrl: "https://api.example.com",
        }),
      ).toEqual({ enabled: false, reason: "shares_site_with_dashboard" });
    }
  });

  it("lights up on a domain of its own", () => {
    expect(
      evaluatePreviewAvailability({
        domain: "Example-Previews.app.",
        secret,
        appUrl: "https://app.example.com",
        apiUrl: "https://api.example.com",
      }),
    ).toEqual({ enabled: true, domain: "example-previews.app" });
  });
});
