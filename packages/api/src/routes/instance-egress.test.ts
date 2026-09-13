import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The egress feed (plans/stable-egress-identity.md §4.3): the one place a
 * customer's firewall team learns which addresses OneCLI calls them from.
 * Three contracts are pinned: the parser refuses anything that is not a
 * clean IPv4 list (a malformed security artifact must not serve), the route
 * is dark when nothing is configured (the self-host posture), and the shape
 * is the AWS `ip-ranges.json` one with the policy fields present.
 *
 * `env.ts` reads the variable at module load, so each case that needs a
 * different value stubs the env and re-imports.
 */

const importFresh = async () => {
  vi.resetModules();
  const env = await import("../lib/env");
  const { instanceEgressRoutes, buildEgressFeed, egressSyncToken } =
    await import("./instance-egress");
  return { env, instanceEgressRoutes, buildEgressFeed, egressSyncToken };
};

// The shared error envelope's module reaches the DB client through the
// channel-provider registry; the feed itself never touches the database.
// Same stub the sibling `instance.test.ts` uses (runner availability is
// what `/v1/instance` itself reads).
vi.mock("@onecli/db", () => ({
  db: {
    runner: {
      count: async () => 0,
      findFirst: async () => null,
    },
  },
}));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_EDITION", "onprem");
  vi.stubEnv("EGRESS_IPV4_ADDRESSES", "");
  vi.stubEnv("EGRESS_REGION", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseEgressIpv4Addresses", () => {
  it("treats unset and blank as 'not published'", async () => {
    const { env } = await importFresh();
    expect(env.parseEgressIpv4Addresses(undefined)).toEqual([]);
    expect(env.parseEgressIpv4Addresses("")).toEqual([]);
    expect(env.parseEgressIpv4Addresses("   ")).toEqual([]);
  });

  it("splits a comma-joined list and tolerates surrounding whitespace", async () => {
    const { env } = await importFresh();
    expect(env.parseEgressIpv4Addresses("203.0.113.10, 203.0.113.11")).toEqual([
      "203.0.113.10",
      "203.0.113.11",
    ]);
  });

  it.each([
    ["a trailing comma", "203.0.113.10,", /empty entry/],
    ["a doubled comma", "203.0.113.10,,203.0.113.11", /empty entry/],
    ["a truncated address", "203.0.113", /not an IPv4 address/],
    ["an out-of-range octet", "256.1.1.1", /not an IPv4 address/],
    [
      "a CIDR suffix (the feed adds /32 itself)",
      "203.0.113.10/32",
      /not an IPv4 address/,
    ],
    ["an IPv6 literal", "2001:db8::1", /not an IPv4 address/],
    ["a duplicate", "203.0.113.10,203.0.113.10", /twice/],
  ])("throws on %s", async (_label, raw, message) => {
    const { env } = await importFresh();
    expect(() => env.parseEgressIpv4Addresses(raw)).toThrow(message);
  });
});

describe("GET /v1/instance/egress", () => {
  it("is 404 with the standard envelope when the deployment publishes nothing", async () => {
    const { instanceEgressRoutes } = await importFresh();
    const res = await instanceEgressRoutes().request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        message: "This deployment does not publish egress addresses.",
        type: "not_found_error",
      },
    });
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("serves every address as a /32 prefix in ip-ranges.json shape, cacheable for an hour", async () => {
    vi.stubEnv("EGRESS_IPV4_ADDRESSES", "203.0.113.10,203.0.113.11");
    vi.stubEnv("EGRESS_REGION", "us-east-1");
    const { instanceEgressRoutes } = await importFresh();

    const res = await instanceEgressRoutes().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");

    const body = (await res.json()) as {
      syncToken: string;
      createDate: string;
      prefixes: unknown[];
    };
    expect(body.syncToken).toMatch(/^[0-9a-f]{16}$/);
    expect(new Date(body.createDate).toISOString()).toBe(body.createDate);
    expect(body.prefixes).toEqual([
      {
        ip_prefix: "203.0.113.10/32",
        region: "us-east-1",
        service: "ONECLI_EGRESS",
        effective: null,
        expires: null,
      },
      {
        ip_prefix: "203.0.113.11/32",
        region: "us-east-1",
        service: "ONECLI_EGRESS",
        effective: null,
        expires: null,
      },
    ]);
  });

  it("reports the explicit EGRESS_REGION, and null when it is unset or blank", async () => {
    vi.stubEnv("EGRESS_IPV4_ADDRESSES", "203.0.113.10");
    vi.stubEnv("EGRESS_REGION", "eu-west-1");
    let { instanceEgressRoutes } = await importFresh();
    let body = (await (await instanceEgressRoutes().request("/")).json()) as {
      prefixes: { region: string | null }[];
    };
    expect(body.prefixes[0]?.region).toBe("eu-west-1");

    // A blank line in an .env template must read as unset, not as "".
    vi.stubEnv("EGRESS_REGION", "  ");
    ({ instanceEgressRoutes } = await importFresh());
    body = (await (await instanceEgressRoutes().request("/")).json()) as {
      prefixes: { region: string | null }[];
    };
    expect(body.prefixes[0]?.region).toBeNull();
  });

  it("is mounted under /v1/instance on the shared app and needs no session", async () => {
    vi.stubEnv("EGRESS_IPV4_ADDRESSES", "203.0.113.10");
    vi.resetModules();
    const { createApiApp } = await import("../app");
    const app = createApiApp({ getSession: async () => null });
    const res = await app.request("/v1/instance/egress");
    expect(res.status).toBe(200);
  });
});

describe("buildEgressFeed", () => {
  it("derives syncToken from the list (replica-stable) and createDate from the instant", async () => {
    const { buildEgressFeed, egressSyncToken } = await importFresh();
    const at = new Date("2026-09-09T12:34:56.789Z");
    const feed = buildEgressFeed(["203.0.113.10"], "us-east-1", at);
    expect(feed.syncToken).toBe(egressSyncToken(["203.0.113.10"]));
    expect(feed.createDate).toBe("2026-09-09T12:34:56.789Z");

    // Two replicas with the same list agree; a list change moves the token.
    expect(egressSyncToken(["203.0.113.10", "203.0.113.11"])).toBe(
      egressSyncToken(["203.0.113.10", "203.0.113.11"]),
    );
    expect(egressSyncToken(["203.0.113.10", "203.0.113.11"])).not.toBe(
      egressSyncToken(["203.0.113.10"]),
    );
  });
});
