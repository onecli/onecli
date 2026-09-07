import { afterEach, describe, expect, it, vi } from "vitest";
import { stripe } from "./stripe";

const resolveMetadata =
  stripe.connectionMethod.type === "api_key"
    ? stripe.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("stripe must expose resolveMetadata");

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("stripe key-shape validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a publishable key, which cannot do anything the catalog offers", async () => {
    await expect(resolveMetadata({ apiKey: "pk_live_abc123" })).rejects.toThrow(
      /publishable key/,
    );
  });

  it("rejects a value that isn't a Stripe key at all", async () => {
    await expect(resolveMetadata({ apiKey: "hunter2" })).rejects.toThrow(
      /doesn't look like a Stripe API key/,
    );
  });

  it.each(["rk_live_abc", "rk_test_abc", "sk_live_abc", "sk_org_abc"])(
    "accepts the usable key shape %s",
    async (apiKey) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
      await expect(resolveMetadata({ apiKey })).resolves.toBeTruthy();
    },
  );

  // Stripe documents the organization prefix as `sk_org` with no guaranteed
  // trailing underscore and no `rk_org` variant, so the shape check must not
  // assume one.
  it("accepts an organization key without a trailing underscore", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      resolveMetadata({ apiKey: "sk_orgAbC123" }),
    ).resolves.toBeTruthy();
  });
});

describe("stripe resolveMetadata account lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hard-fails on 401 — the one response that proves the key is bad", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: {} })),
    );
    await expect(
      resolveMetadata({ apiKey: "rk_live_revoked" }),
    ).rejects.toThrow(/Stripe rejected this API key/);
  });

  // The security-relevant case: a tightly-scoped restricted key WITHOUT the
  // Account permission is exactly what Stripe tells agent users to create.
  // Failing it would punish the least-privilege setup we recommend.
  it("accepts a 403 — a valid key that simply lacks the Account permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(403, { error: {} })),
    );
    const meta = await resolveMetadata({ apiKey: "rk_live_scoped" });
    expect(meta).toMatchObject({ livemode: true, name: "Stripe" });
  });

  it("never hard-fails when Stripe is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      resolveMetadata({ apiKey: "rk_live_abc" }),
    ).resolves.toMatchObject({ livemode: true });
  });

  it("labels the connection from the account and sends the key as a Bearer header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "acct_123",
        email: "owner@example.com",
        settings: { dashboard: { display_name: "Acme Inc" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const meta = await resolveMetadata({ apiKey: "rk_live_good" });
    expect(meta).toMatchObject({
      accountId: "acct_123",
      name: "Acme Inc",
      username: "Acme Inc",
      livemode: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/account");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer rk_live_good",
    );
  });

  it("prefers an explicit label so two keys on one account stay tellable apart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: "acct_123",
          settings: { dashboard: { display_name: "Acme Inc" } },
        }),
      ),
    );
    const meta = await resolveMetadata({
      apiKey: "rk_test_good",
      label: "sandbox",
    });
    expect(meta).toMatchObject({ name: "sandbox", username: "sandbox" });
  });

  it("derives live/test mode from the key itself, not from the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      resolveMetadata({ apiKey: "rk_test_abc" }),
    ).resolves.toMatchObject({ livemode: false, tags: ["test"] });
    await expect(
      resolveMetadata({ apiKey: "rk_live_abc" }),
    ).resolves.toMatchObject({ livemode: true, tags: ["live"] });
  });

  // An organization key supports both modes and carries no marker, and the
  // Account object has no `livemode` field either. Claiming "test" for one
  // would invite treating real money as a sandbox, so mode is simply absent.
  it("reports no mode for an organization key rather than guessing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const meta = await resolveMetadata({ apiKey: "sk_orgAbC123" });
    expect(meta).toMatchObject({ tags: [] });
    expect(meta).not.toHaveProperty("livemode");
  });
});
