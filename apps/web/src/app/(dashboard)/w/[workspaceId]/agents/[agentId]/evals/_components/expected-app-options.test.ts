import { describe, expect, it } from "vitest";
import type {
  EffectiveCredentialEntry,
  EffectiveCredentialsResult,
} from "@/lib/api/policy-visibility";
import { appLabel, expectedAppOptions } from "./expected-app-options";

const connection = (
  id: string,
  provider: string,
): EffectiveCredentialEntry => ({
  kind: "connection",
  id,
  label: null,
  provider,
  status: "usable",
  orgBlocked: false,
  provenance: [],
});

const secret = (id: string, host: string): EffectiveCredentialEntry => ({
  kind: "secret",
  id,
  name: `Custom ${id}`,
  host,
  status: "usable",
  provenance: [],
});

const credentials = (
  connections: EffectiveCredentialEntry[],
  secrets: EffectiveCredentialEntry[] = [],
): EffectiveCredentialsResult => ({
  agentId: "agent-1",
  mode: "selective",
  connections,
  secrets,
});

describe("expectedAppOptions", () => {
  it("offers each connected app once, by provider ID, whatever the account count or case", () => {
    expect(
      expectedAppOptions(
        credentials([
          connection("a", "GMAIL"),
          connection("b", "gmail"),
          connection("c", "notion"),
        ]),
      ),
    ).toEqual([
      { id: "gmail", label: "Gmail" },
      { id: "notion", label: "Notion" },
    ]);
  });

  it("falls back to the provider ID for an app the registry does not know", () => {
    expect(
      expectedAppOptions(credentials([connection("a", "acme-crm")])),
    ).toEqual([{ id: "acme-crm", label: "acme-crm" }]);
  });

  it("offers a custom app by its exact host, merging credentials on one host", () => {
    const result = expectedAppOptions(
      credentials(
        [],
        [
          secret("one", "API.EXAMPLE.COM:443"),
          secret("two", "api.example.com"),
          secret("three", "internal.example.com"),
        ],
      ),
    );
    expect(result).toEqual([
      { id: "host:api.example.com", label: "Custom one, Custom two" },
      { id: "host:internal.example.com", label: "Custom three" },
    ]);
  });

  it("leaves model providers out: they are not apps the agent used", () => {
    expect(
      expectedAppOptions(
        credentials(
          [],
          [secret("llm", "api.openai.com"), secret("crm", "crm.example.com")],
        ),
      ).map((option) => option.id),
    ).toEqual(["host:crm.example.com"]);
  });

  it.each([
    "*.example.com",
    "api..example.com",
    "-api.example.com",
    "api_example.com",
    "api.example.com:8443",
    "https://api.example.com",
    `${"a".repeat(64)}.com`,
  ])("shows %s, which cannot be checked, as unavailable", (host) => {
    const [option] = expectedAppOptions(
      credentials([], [secret("custom", host)]),
    );
    expect(option?.unavailable).toBeTruthy();
  });

  it("shows a host too long to store as unavailable", () => {
    const host = `${"a".repeat(48)}.${"b".repeat(48)}.com`;
    const [option] = expectedAppOptions(
      credentials([], [secret("custom", host)]),
    );
    expect(option?.unavailable).toBe("This host name is too long to check");
  });

  it.each(["crm.example.com", "internal", "127.0.0.1", "CRM.EXAMPLE.COM:443"])(
    "offers concrete host %s",
    (host) => {
      const [option] = expectedAppOptions(
        credentials([], [secret("custom", host)]),
      );
      expect(option?.unavailable).toBeUndefined();
      expect(option?.id).toBe(
        `host:${host.toLowerCase().replace(/:443$/, "")}`,
      );
    },
  );
});

describe("appLabel", () => {
  const options = expectedAppOptions(
    credentials([connection("a", "gmail")], [secret("crm", "crm.example.com")]),
  );

  it("reads an offered app by its option label", () => {
    expect(appLabel("gmail", options)).toBe("Gmail");
    expect(appLabel("host:crm.example.com", options)).toBe("Custom crm");
  });

  it("still reads an app the agent can no longer use, so it can be removed", () => {
    expect(appLabel("notion", options)).toBe("Notion");
    expect(appLabel("host:old.example.com", options)).toBe("old.example.com");
    expect(appLabel("retired-app", options)).toBe("retired-app");
  });
});
