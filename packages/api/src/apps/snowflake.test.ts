import { afterEach, describe, expect, it, vi } from "vitest";
import { snowflake } from "./snowflake";

const resolveMetadata =
  snowflake.connectionMethod.type === "api_key"
    ? snowflake.connectionMethod.resolveMetadata
    : undefined;

if (!resolveMetadata) throw new Error("snowflake must expose resolveMetadata");

// The host field feeds two security-sensitive sinks: the gateway's
// per-connection injection gate (a wrong host silently never injects) and the
// connect-time validation fetch (the PAT rides as a Bearer header to whatever
// origin the URL resolves). These tests pin the strict-host contract.
describe("snowflake resolveMetadata host validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  const failingFetch = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

  it("rejects a bare account identifier (would never inject at the gateway)", async () => {
    await expect(
      resolveMetadata({ token: "t", host: "myorg-myaccount" }),
    ).rejects.toThrow(/full Snowflake host/);
  });

  it("rejects a lookalike domain that merely ends with the suffix", async () => {
    await expect(
      resolveMetadata({ token: "t", host: "evilsnowflakecomputing.com" }),
    ).rejects.toThrow(/full Snowflake host/);
  });

  it("rejects a crafted value that would route the validation fetch elsewhere", async () => {
    await expect(
      resolveMetadata({
        token: "t",
        host: "evil.com#x.snowflakecomputing.com",
      }),
    ).rejects.toThrow(/full Snowflake host/);
    await expect(
      resolveMetadata({
        token: "t",
        host: "evil.com?x=.snowflakecomputing.com",
      }),
    ).rejects.toThrow(/full Snowflake host/);
  });

  it("accepts a pasted account URL and derives the account label", async () => {
    failingFetch();
    const meta = await resolveMetadata({
      token: "t",
      host: "https://MyOrg-MyAccount.snowflakecomputing.com/console",
    });
    expect(meta).toMatchObject({
      name: "myorg-myaccount",
      url: "https://myorg-myaccount.snowflakecomputing.com",
    });
  });

  it("derives the connection name from the account and never hard-fails on an unreachable host", async () => {
    failingFetch();
    const meta = await resolveMetadata({
      token: "t",
      host: "myorg-myaccount.snowflakecomputing.com",
    });
    expect(meta).toMatchObject({ name: "myorg-myaccount" });
  });

  it("tags the connection verified when the PAT authenticates", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const meta = await resolveMetadata({
      token: "pat-secret",
      host: "myorg-myaccount.snowflakecomputing.com",
    });
    expect(meta).toMatchObject({ tags: ["myorg-myaccount", "verified"] });
    // The probe goes to the validated host itself, with the PAT header shape.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://myorg-myaccount.snowflakecomputing.com/api/v2/databases",
    );
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer pat-secret",
    );
  });
});
