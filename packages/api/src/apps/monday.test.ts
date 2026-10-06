import { describe, expect, it } from "vitest";
import { monday } from "./monday";

const method = monday.connectionMethod;
if (method.type !== "oauth") throw new Error("expected an OAuth definition");

const authorizeUrl = async () =>
  new URL(
    await method.buildAuthUrl({
      appCredentials: { clientId: "client-1", clientSecret: "secret-1" },
      redirectUri: "https://api.example.com/v1/apps/monday/callback",
      scopes: [],
      state: "state-1",
    }),
  );

describe("monday OAuth authorize URL", () => {
  it("keeps the standard OAuth parameters", async () => {
    const url = await authorizeUrl();
    expect(url.origin + url.pathname).toBe(
      "https://auth.monday.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/v1/apps/monday/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  // monday blocks authorize ("App is not installed") until an account admin
  // has installed the app. This flag sends an admin through install first
  // and back to authorize, so Connect works in one pass.
  it("asks monday to install OneCLI first when the account lacks it", async () => {
    expect(
      (await authorizeUrl()).searchParams.get("force_install_if_needed"),
    ).toBe("true");
  });
});

describe("monday connect note", () => {
  it("tells non-admins they need an account admin, and links the docs", () => {
    expect(monday.connectNote?.text).toMatch(/account admin/);
    expect(monday.connectNote?.fallback).toMatch(/^Not an admin\?/);
    // The exact id Mintlify gives the "If you’re not a Monday.com admin"
    // heading. A slug that drops the apostrophe or the dot lands at the top
    // of the page instead of the section.
    expect(monday.connectNote?.link?.url).toBe(
      "https://onecli.sh/docs/integrations/monday#if-you’re-not-a-monday-com-admin",
    );
  });
});
