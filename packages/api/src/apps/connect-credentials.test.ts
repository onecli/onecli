import { describe, expect, it, vi } from "vitest";
import { resolveConnectCredentials } from "./connect-credentials";
import type { AppDefinition } from "./types";

// The caller's organization, which server-owned fields resolve against.
const ORG = "org-1";

// The org's stored external ID, keyed by org so a test can prove the value
// follows the CALLER'S org rather than anything in the request.
const orgExternalIds: Record<string, string> = {
  "org-1": "onecli-org-1-external-id",
  "org-2": "onecli-org-2-external-id",
};

vi.mock("../services/aws-external-id-service", () => ({
  ensureOrgAwsExternalId: async (organizationId: string) =>
    orgExternalIds[organizationId] ?? "",
}));

// Minimal typed app fixtures — the helper only reads connectionMethod /
// additionalMethods, but the full shape keeps the fixtures honest.
const apiKeyApp: AppDefinition = {
  id: "keyapp",
  name: "Key App",
  icon: "/icons/keyapp.svg",
  description: "API-key test app",
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
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      {
        fields: { apiKey: "sk-123" },
      },
      ORG,
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { access_token: "sk-123", apiKey: "sk-123" },
      metadata: { name: "API Key" },
    });
  });

  // Regression: the required-field check tests `.trim()`, so a key pasted with
  // a trailing newline PASSES validation. Storing it verbatim then injects
  // `Bearer <key>\n` upstream, which providers reject (Stripe answers 401) —
  // a connection that looks connected but can never work.
  it("trims surrounding whitespace off the stored access_token", async () => {
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      {
        fields: { apiKey: "  sk-123\n" },
      },
      ORG,
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { access_token: "sk-123" },
    });
  });

  it("rejects a missing required field with the field label", async () => {
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      {
        fields: { apiKey: "   " },
      },
      ORG,
    );
    expect(result).toEqual({ ok: false, error: "API Key is required" });
  });

  it("skips optional fields during validation", async () => {
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      {
        fields: { apiKey: "sk-123" },
      },
      ORG,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the primary oauth method for direct connect", async () => {
    const result = await resolveConnectCredentials(
      "oauthapp",
      oauthApp,
      {
        fields: { token: "t" },
      },
      ORG,
    );
    expect(result).toEqual({
      ok: false,
      error: 'Provider "oauthapp" uses OAuth flow, not direct credentials',
    });
  });

  it("selects an additional method via body.method", async () => {
    const result = await resolveConnectCredentials(
      "oauthapp",
      oauthApp,
      {
        fields: { token: "t-1" },
        method: "api_key",
      },
      ORG,
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { access_token: "t-1", token: "t-1" },
    });
  });

  it("rejects an explicit but unknown method instead of falling back", async () => {
    const result = await resolveConnectCredentials(
      "oauthapp",
      oauthApp,
      {
        fields: { token: "t" },
        method: "carrier_pigeon",
      },
      ORG,
    );
    expect(result).toEqual({
      ok: false,
      error: 'Provider "oauthapp" has no "carrier_pigeon" connection method',
    });
  });

  it("rejects a body without fields", async () => {
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      null,
      ORG,
    );
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
    const result = await resolveConnectCredentials(
      "failing",
      failingApp,
      {
        fields: { apiKey: "bad" },
      },
      ORG,
    );
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
    const missing = await resolveConnectCredentials(
      "importer",
      importApp,
      {
        fields: { other: "x" },
      },
      ORG,
    );
    expect(missing).toEqual({
      ok: false,
      error: "Refresh Token is required",
    });

    // privateKey present → service_account group validates and exchanges.
    const ok = await resolveConnectCredentials(
      "importer",
      importApp,
      {
        fields: { privateKey: "pk-1" },
      },
      ORG,
    );
    expect(ok).toMatchObject({
      ok: true,
      credentials: { imported: "pk-1" },
    });
  });
  // ── Server-owned fields ────────────────────────────────────────────────
  // The reason `serverFields` exists: AWS's external ID defeats the
  // confused-deputy problem only while the CUSTOMER cannot choose it.

  const serverFieldApp: AppDefinition = {
    ...apiKeyApp,
    id: "awsish",
    connectionMethod: {
      type: "credentials_import",
      fields: [{ name: "roleArn", label: "Role ARN", placeholder: "arn:" }],
      exchangeCredentials: async (fields) => ({
        credentials: {
          roleArn: fields.roleArn,
          externalId: fields.externalId,
        },
        scopes: [],
      }),
      serverFields: [{ name: "externalId", source: "orgAwsExternalId" }],
    },
  };

  it("fills a server field from the caller's organization", async () => {
    const result = await resolveConnectCredentials(
      "awsish",
      serverFieldApp,
      { fields: { roleArn: "arn:aws:iam::123456789012:role/R" } },
      ORG,
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { externalId: "onecli-org-1-external-id" },
    });
  });

  it("DISCARDS a client-submitted value for a server field", async () => {
    // The confused-deputy attempt: a caller in org-1 posting org-2's external
    // id (or any string) must not have it reach the credentials.
    const result = await resolveConnectCredentials(
      "awsish",
      serverFieldApp,
      {
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/R",
          externalId: "onecli-org-2-external-id",
        },
      },
      ORG,
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { externalId: "onecli-org-1-external-id" },
    });
    if (result.ok) {
      expect(result.fields.externalId).toBe("onecli-org-1-external-id");
    }
  });

  it("resolves the server field per caller org, not globally", async () => {
    const result = await resolveConnectCredentials(
      "awsish",
      serverFieldApp,
      { fields: { roleArn: "arn:aws:iam::123456789012:role/R" } },
      "org-2",
    );
    expect(result).toMatchObject({
      ok: true,
      credentials: { externalId: "onecli-org-2-external-id" },
    });
  });

  it("fails closed when the server field cannot be resolved", async () => {
    // An org with no resolvable external id yields "". The app's own guard
    // must refuse rather than assume the role with an empty ExternalId, which
    // would silently drop the confused-deputy protection.
    const result = await resolveConnectCredentials(
      "awsish",
      {
        ...serverFieldApp,
        connectionMethod: {
          ...serverFieldApp.connectionMethod,
          type: "credentials_import",
          fields: [{ name: "roleArn", label: "Role ARN", placeholder: "arn:" }],
          exchangeCredentials: async (fields) => {
            if (!fields.externalId) throw new Error("external id missing");
            return { credentials: {}, scopes: [] };
          },
          serverFields: [{ name: "externalId", source: "orgAwsExternalId" }],
        },
      },
      { fields: { roleArn: "arn:aws:iam::123456789012:role/R" } },
      "org-with-no-id",
    ).catch((e: Error) => e);

    expect(result).toBeInstanceOf(Error);
  });

  it("leaves apps without serverFields untouched", async () => {
    const result = await resolveConnectCredentials(
      "keyapp",
      apiKeyApp,
      { fields: { apiKey: "sk-123", externalId: "attacker" } },
      ORG,
    );
    // No serverFields declared → nothing is stripped; the field is just a
    // field, exactly as before.
    expect(result).toMatchObject({
      ok: true,
      credentials: { externalId: "attacker" },
    });
  });
});
