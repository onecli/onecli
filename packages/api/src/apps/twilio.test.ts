import { afterEach, describe, expect, it, vi } from "vitest";
import { twilio, normalizeTwilioRegion } from "./twilio";
import { twilioPermissions } from "./app-permissions/twilio";
import { pathMatches } from "../lib/path-match";
import { defaultConnectionGrant } from "../services/grants-compile";

const exchange =
  twilio.connectionMethod.type === "credentials_import"
    ? twilio.connectionMethod.exchangeCredentials
    : undefined;
if (!exchange) throw new Error("twilio must expose exchangeCredentials");

const KEY = `SK${"a".repeat(32)}`;
const ACCOUNT = `AC${"b".repeat(32)}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("twilio exchangeCredentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("probes Balance.json in the chosen region with Basic sid:secret, bounded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(200, { account_sid: ACCOUNT }));
    vi.stubGlobal("fetch", fetchMock);
    await exchange({ region: "ie1", sid: ` ${KEY} `, secret: "s3cret\n" });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/${KEY}/Balance.json`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${KEY}:s3cret`).toString("base64")}`,
        },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("stores only the joined pair and region; the Account SID names the connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(200, { account_sid: ACCOUNT })),
    );
    const result = await exchange({ region: "us1", sid: KEY, secret: "s" });
    expect(result.credentials).toEqual({
      access_token: `${KEY}:s`,
      region: "us1",
    });
    expect(result.metadata).toEqual({ name: ACCOUNT, tags: ["US1"] });
  });

  it("accepts the Account SID with the Auth Token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(200, { account_sid: ACCOUNT })),
    );
    const result = await exchange({ region: "us1", sid: ACCOUNT, secret: "t" });
    expect(result.credentials).toEqual({
      access_token: `${ACCOUNT}:t`,
      region: "us1",
    });
    expect(result.metadata).toEqual({
      name: ACCOUNT,
      tags: ["US1", "Auth Token"],
    });
  });

  // Twilio's 401 codes: 20003 (wrong secret, other region) and 70051 (a key
  // that failed authorization, Restricted keys missing a permission included).
  it.each([20003, 70051])(
    "hard-fails on 401 / %i, naming the region and Restricted keys",
    async (code) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, { code })));
      await expect(
        exchange({ region: "au1", sid: KEY, secret: "bad" }),
      ).rejects.toThrow(
        /rejected these credentials in the AU1 region.*Restricted key/,
      );
    },
  );

  it("never hard-fails when Twilio is unreachable or errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      exchange({ region: "us1", sid: KEY, secret: "s" }),
    ).resolves.toMatchObject({
      credentials: { access_token: `${KEY}:s` },
      metadata: { name: "Twilio" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(503, {})));
    await expect(
      exchange({ region: "us1", sid: KEY, secret: "s" }),
    ).resolves.toMatchObject({ metadata: { name: "Twilio" } });
  });

  it("ignores a malformed account_sid in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json(200, { account_sid: "evil.example" })),
    );
    const result = await exchange({ region: "us1", sid: KEY, secret: "s" });
    expect(result.metadata).toEqual({ name: "Twilio", tags: ["US1"] });
  });

  it.each([
    [{ region: "jp1", sid: KEY, secret: "s" }, /Region must be/],
    [
      { region: "us1", sid: "not-a-sid", secret: "s" },
      /should be an API key SID/,
    ],
    [{ region: "us1", sid: `SK${"a".repeat(31)}`, secret: "s" }, /should be/],
    // Twilio SIDs open with an uppercase prefix.
    [{ region: "us1", sid: `sk${"a".repeat(32)}`, secret: "s" }, /should be/],
    [{ region: "us1", sid: KEY, secret: "  " }, /secret .* is required/],
  ])("rejects bad input %j before calling Twilio", async (fields, error) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchange(fields)).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes regions case- and whitespace-insensitively", () => {
    expect(normalizeTwilioRegion(" IE1 ")).toBe("ie1");
    expect(normalizeTwilioRegion("us2")).toBeNull();
  });
});

// Which tools a request falls under, on any of the three regional hosts.
const toolsFor = (host: string, method: string, path: string) =>
  twilioPermissions.groups
    .flatMap((g) => g.tools)
    .filter((t) => {
      const hosts = [t.hostPattern, ...(t.hostAliasPatterns ?? [])];
      const methods = t.methods ?? (t.method ? [t.method] : null);
      const patterns = [t.pathPattern, ...(t.aliasPatterns ?? [])];
      return (
        hosts.includes(host) &&
        (methods === null || methods.includes(method)) &&
        patterns.some((p) => pathMatches(path, p))
      );
    })
    .map((t) => t.id);

const readIds = new Set(
  twilioPermissions.groups
    .filter((g) => g.category === "read")
    .flatMap((g) => g.tools.map((t) => t.id)),
);

describe("twilio permission catalog", () => {
  const A = `/2010-04-01/Accounts/${ACCOUNT}`;
  it.each([
    [
      "api.twilio.com",
      "GET",
      `${A}/Messages.json?PageSize=20`,
      ["read_messages"],
    ],
    ["api.twilio.com", "GET", `${A}/Messages/SM1.json`, ["read_messages"]],
    [
      "api.twilio.com",
      "GET",
      `${A}/Messages/SM1/Media.json`,
      ["read_messages"],
    ],
    ["api.twilio.com", "POST", `${A}/Messages.json`, ["send_message"]],
    [
      "api.dublin.ie1.twilio.com",
      "POST",
      `${A}/Messages.json`,
      ["send_message"],
    ],
    ["api.twilio.com", "POST", `${A}/Messages/SM1.json`, ["manage_messages"]],
    ["api.twilio.com", "DELETE", `${A}/Messages/SM1.json`, ["manage_messages"]],
    ["api.twilio.com", "GET", `${A}/Calls.json`, ["read_calls"]],
    ["api.twilio.com", "POST", `${A}/Calls.json`, ["place_call"]],
    ["api.twilio.com", "POST", `${A}/Calls/CA1.json`, ["manage_calls"]],
    ["api.twilio.com", "GET", `${A}/Recordings.json`, ["read_calls"]],
    [
      "api.twilio.com",
      "GET",
      `${A}/IncomingPhoneNumbers.json`,
      ["read_phone_numbers"],
    ],
    [
      "api.twilio.com",
      "GET",
      `${A}/AvailablePhoneNumbers/US/Local.json`,
      ["read_phone_numbers"],
    ],
    [
      "api.twilio.com",
      "POST",
      `${A}/IncomingPhoneNumbers.json`,
      ["manage_phone_numbers"],
    ],
    [
      "api.twilio.com",
      "DELETE",
      `${A}/IncomingPhoneNumbers/PN1.json`,
      ["manage_phone_numbers"],
    ],
    ["api.twilio.com", "GET", `${A}/Balance.json`, ["read_usage"]],
    ["api.twilio.com", "GET", `${A}/Usage/Records.json`, ["read_usage"]],
    [
      "lookups.twilio.com",
      "GET",
      "/v2/PhoneNumbers/+14155552671",
      ["lookup_phone_number"],
    ],
    [
      "messaging.sydney.au1.twilio.com",
      "GET",
      "/v1/Services",
      ["read_messaging_services"],
    ],
    [
      "verify.twilio.com",
      "POST",
      "/v2/Services/VA1/Verifications",
      ["send_verification"],
    ],
    [
      "verify.twilio.com",
      "POST",
      "/v2/Services/VA1/VerificationCheck",
      ["send_verification"],
    ],
    [
      "verify.twilio.com",
      "GET",
      "/v2/Services/VA1/Verifications/VE1",
      ["read_verify_services"],
    ],
    [
      "verify.twilio.com",
      "POST",
      "/v2/Services/VA1/Verifications/VE1",
      ["update_verification"],
    ],
    ["verify.twilio.com", "POST", "/v2/Services", ["manage_verify_services"]],
    [
      "conversations.twilio.com",
      "POST",
      "/v1/Conversations/CH1/Messages",
      ["manage_conversations"],
    ],
  ])("%s %s %s → %j", (host, method, path, expected) => {
    expect(toolsFor(host, method, path)).toEqual(expected);
  });

  it("keeps every message, call, and number purchase out of the read tools", () => {
    for (const [host, method, path] of [
      ["api.twilio.com", "POST", `${A}/Messages.json`],
      ["api.twilio.com", "POST", `${A}/Calls.json`],
      ["api.twilio.com", "POST", `${A}/IncomingPhoneNumbers.json`],
      ["verify.twilio.com", "POST", "/v2/Services/VA1/Verifications"],
    ] as const) {
      for (const id of toolsFor(host, method, path)) {
        expect(readIds.has(id), `${method} ${path} → ${id}`).toBe(false);
      }
    }
  });

  it("covers every tool on all three regional hosts", () => {
    for (const t of twilioPermissions.groups.flatMap((g) => g.tools)) {
      const product = t.hostPattern.replace(/\.twilio\.com$/, "");
      expect(t.hostAliasPatterns).toEqual([
        `${product}.dublin.ie1.twilio.com`,
        `${product}.sydney.au1.twilio.com`,
      ]);
    }
  });

  it("covers nothing on hosts outside the API", () => {
    expect(toolsFor("www.twilio.com", "GET", `${A}/Messages.json`)).toEqual([]);
    expect(
      toolsFor("console.twilio.com", "POST", `${A}/Messages.json`),
    ).toEqual([]);
  });

  // Twilio answers the Account resource with the Auth Token (the
  // subaccounts' too, on the list). Matching no tool keeps those requests on
  // the grant's "everything else" row, which every default grant holds for
  // approval, so a read-only grant never hands an agent the master credential.
  it("keeps the credential-returning Account resource out of every tool", () => {
    const accountPaths = [`${A}.json`, "/2010-04-01/Accounts.json"];
    for (const host of [
      "api.twilio.com",
      "api.dublin.ie1.twilio.com",
      "api.sydney.au1.twilio.com",
    ]) {
      for (const path of accountPaths) {
        for (const method of ["GET", "POST"]) {
          expect(
            toolsFor(host, method, path),
            `${method} ${host}${path}`,
          ).toEqual([]);
        }
      }
    }
    expect(defaultConnectionGrant("twilio")).toMatchObject({
      access: "custom",
      otherReads: "ask",
      otherWrites: "ask",
    });
  });

  // Approving a verification passes it without its code: a write of its own,
  // never something allowing "Send a verification code" also allows.
  it("keeps approving a verification apart from sending one", () => {
    const approve = toolsFor(
      "verify.twilio.com",
      "POST",
      "/v2/Services/VA1/Verifications/VE1",
    );
    expect(approve).toEqual(["update_verification"]);
    expect(approve.some((id) => readIds.has(id))).toBe(false);
  });
});
