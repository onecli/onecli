import { describe, expect, it } from "vitest";
import { resolveConnectCredentials } from "./connect-credentials";
import type { AppDefinition } from "./types";

// Minimal typed app fixtures — the helper only reads connectionMethod /
// additionalMethods, but the full shape keeps the fixtures honest.
const apiKeyApp: AppDefinition = {
  id: "keyapp",
  name: "Key App",
  icon: "/icons/keyapp.svg",
  description: "API-key test app",
  available: true,
  connectionMethod: {
    type: "api_key",
    fields: [
      { name: "apiKey", label: "API Key", placeholder: "key" },
      {
        name: "region",
        label: "Region",
        placeholder: "us",
        optional: true,
      },
    ],
  },
};

const oauthApp: AppDefinition = {
  id: "oauthapp",
  name: "OAuth App",
  icon: "/icons/oauthapp.svg",
  description: "OAuth test app",
  available: true,
  connectionMethod: {
    type: "oauth",
    buildAuthUrl: () => "https://provider.example/auth",
    exchangeCode: async () => ({ credentials: {}, scopes: [] }),
  },
  additionalMethods: [
    {
      type: "api_key",
      fields: [{ name: "token", label: "Token", placeholder: "tok" }],
    },
  ],
};

describe("resolveConnectCredentials", () => {
  it("builds api_key credentials with the primary field as access_token", async () => {
    const result = await resolveConnectCredentials("keyapp", apiKeyApp, {
      fields: { apiKey: "sk-123" },
    });
    expect(result).toMatchObject({
      ok: true,
      credentials: { access_token: "sk-123", apiKey: "sk-123" },
      metadata: { name: "API Key" },
    });
  });

  it("rejects a missing required field with the field label", async () => {
    const result = await resolveConnectCredentials("keyapp", apiKeyApp, {
      fields: { apiKey: "   " },
    });
    expect(result).toEqual({ ok: false, error: "API Key is required" });
  });

  it("skips optional fields during validation", async () => {
    const result = await resolveConnectCredentials("keyapp", apiKeyApp, {
      fields: { apiKey: "sk-123" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects the primary oauth method for direct connect", async () => {
    const result = await resolveConnectCredentials("oauthapp", oauthApp, {
      fields: { token: "t" },
    });
    expect(result).toEqual({
      ok: false,
      error: 'Provider "oauthapp" uses OAuth flow, not direct credentials',
    });
  });

  it("selects an additional method via body.method", async () => {
    const result = await resolveConnectCredentials("oauthapp", oauthApp, {
      fields: { token: "t-1" },
      method: "api_key",
    });
    expect(result).toMatchObject({
      ok: true,
      credentials: { access_token: "t-1", token: "t-1" },
    });
  });

  it("rejects an explicit but unknown method instead of falling back", async () => {
    const result = await resolveConnectCredentials("oauthapp", oauthApp, {
      fields: { token: "t" },
      method: "carrier_pigeon",
    });
    expect(result).toEqual({
      ok: false,
      error: 'Provider "oauthapp" has no "carrier_pigeon" connection method',
    });
  });

  it("rejects cloud_only methods", async () => {
    const cloudOnlyApp: AppDefinition = {
      ...apiKeyApp,
      id: "cloudy",
      connectionMethod: { type: "cloud_only" },
    };
    const result = await resolveConnectCredentials("cloudy", cloudOnlyApp, {
      fields: {},
    });
    expect(result).toEqual({
      ok: false,
      error: 'Provider "cloudy" is only available in OneCLI Cloud',
    });
  });

  it("rejects a body without fields", async () => {
    const result = await resolveConnectCredentials("keyapp", apiKeyApp, null);
    expect(result).toEqual({
      ok: false,
      error: "Missing fields in request body",
    });
  });

  it("maps resolveMetadata failures to the thrown message", async () => {
    const failingApp: AppDefinition = {
      ...apiKeyApp,
      id: "failing",
      connectionMethod: {
        type: "api_key",
        fields: [{ name: "apiKey", label: "API Key", placeholder: "key" }],
        resolveMetadata: async () => {
          throw new Error("Invalid API key");
        },
      },
    };
    const result = await resolveConnectCredentials("failing", failingApp, {
      fields: { apiKey: "bad" },
    });
    expect(result).toEqual({ ok: false, error: "Invalid API key" });
  });

  it("validates credentials_import group fields by privateKey presence", async () => {
    const importApp: AppDefinition = {
      ...apiKeyApp,
      id: "importer",
      connectionMethod: {
        type: "credentials_import",
        fields: [
          {
            name: "privateKey",
            label: "Private Key",
            placeholder: "-----BEGIN",
            group: "service_account",
          },
          {
            name: "refreshToken",
            label: "Refresh Token",
            placeholder: "rt",
            group: "authorized_user",
          },
        ],
        exchangeCredentials: async (fields) => ({
          credentials: { imported: fields.privateKey ?? fields.refreshToken },
          scopes: [],
        }),
      },
    };

    // No privateKey → the authorized_user group is required.
    const missing = await resolveConnectCredentials("importer", importApp, {
      fields: { other: "x" },
    });
    expect(missing).toEqual({
      ok: false,
      error: "Refresh Token is required",
    });

    // privateKey present → service_account group validates and exchanges.
    const ok = await resolveConnectCredentials("importer", importApp, {
      fields: { privateKey: "pk-1" },
    });
    expect(ok).toMatchObject({
      ok: true,
      credentials: { imported: "pk-1" },
    });
  });
});
