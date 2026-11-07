import { describe, expect, it } from "vitest";
import {
  customConnectionApproveSchema,
  customConnectionProposalSchema,
  isDeniedHeaderName,
  registrableDomainOf,
} from "./custom-connection";

const good = {
  name: "AcmeCRM",
  hostPattern: "api.acmecrm.io",
  headerName: "X-Api-Key",
  valueFormat: "{value}",
  docsUrl: "https://docs.acmecrm.io/auth",
  reason: "You asked me to pull your AcmeCRM campaigns.",
};

const refusal = (patch: Record<string, unknown>) => {
  const r = customConnectionProposalSchema.safeParse({ ...good, ...patch });
  expect(r.success).toBe(false);
  return r.success ? "" : (r.error.issues[0]?.message ?? "");
};

describe("customConnectionProposalSchema", () => {
  it("accepts a good proposal, lowercasing the host and cleaning labels", () => {
    const r = customConnectionProposalSchema.parse({
      ...good,
      name: "  Acme\u202ECRM\n ",
      hostPattern: "API.acmecrm.io",
      headerName: "Authorization",
      valueFormat: "Bearer {value}",
      pathPattern: "/v1/*",
    });
    expect(r.name).toBe("AcmeCRM");
    expect(r.hostPattern).toBe("api.acmecrm.io");
    expect(r.headerName).toBe("Authorization");
  });

  it("accepts a whole-label wildcard under a registrable domain", () => {
    expect(
      customConnectionProposalSchema.safeParse({
        ...good,
        hostPattern: "*.acmecrm.io",
      }).success,
    ).toBe(true);
  });

  it("has NO value field: an extra key argument is refused, not stored", () => {
    refusal({ value: "sk-live-123" });
    refusal({ key: "sk-live-123" });
  });

  it.each([
    ["127.0.0.1"],
    ["10.0.0.5"],
    ["169.254.169.254"],
    ["[::1]"],
    ["0x7f000001"],
    ["2130706433"],
  ])("refuses IP literal %s", (hostPattern) => {
    refusal({ hostPattern });
  });

  it.each([
    ["localhost"],
    ["metadata.google.internal"],
    ["printer.local"],
    ["*.com"],
    ["https://api.acmecrm.io"],
    ["api.acmecrm.io/v1"],
  ])("refuses non-public or malformed host %s", (hostPattern) => {
    refusal({ hostPattern });
  });

  it.each([
    ["Host"],
    ["content-length"],
    ["Transfer-Encoding"],
    ["Connection"],
    ["Cookie"],
    ["Proxy-Authorization"],
    ["X-OneCLI-Connection-Id"],
  ])("refuses reserved header %s", (headerName) => {
    expect(refusal({ headerName })).toMatch(/reserved/);
  });

  it.each([
    ["X Api Key"],
    ["X-Api-Key\r\nEvil: 1"],
    ["Ключ"],
    ["a".repeat(65)],
  ])("refuses an invalid header token %j", (headerName) => {
    refusal({ headerName });
  });

  it("allows Authorization", () => {
    expect(isDeniedHeaderName("Authorization")).toBe(false);
  });

  it.each([
    ["Bearer"],
    ["{value}{value}"],
    ["Bearer {value}\r\nX-Evil: 1"],
    ["x".repeat(501) + "{value}"],
  ])("refuses valueFormat %j", (valueFormat) => {
    refusal({ valueFormat });
  });

  it.each([["Basic {value}"], ["  basic {value}"], ["BASIC {value}"]])(
    "refuses HTTP Basic %j and tells the agent it isn't supported",
    (valueFormat) => {
      expect(refusal({ headerName: "Authorization", valueFormat })).toContain(
        "HTTP Basic auth isn't supported",
      );
    },
  );

  it("still accepts a header that merely starts with the letters basic", () => {
    expect(
      customConnectionProposalSchema.safeParse({
        ...good,
        valueFormat: "Basically{value}",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["api.acmecrm.іo"], // Cyrillic і
    ["аpi.acmecrm.io"], // Cyrillic а
    ["api.acmecrm.io\u202E"],
    ["api_x.acmecrm.io"],
  ])("refuses a non-ASCII or look-alike host %j", (hostPattern) => {
    refusal({ hostPattern });
  });

  it("accepts an xn-- punycode host", () => {
    expect(
      customConnectionProposalSchema.safeParse({
        ...good,
        hostPattern: "api.xn--bcher-kva.de",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["Bearer\u202E {value}"],
    ["\u200BBearer {value}"],
    ["Bearer\u0085{value}"],
  ])("refuses hidden or bidi characters in valueFormat %j", (valueFormat) => {
    refusal({ headerName: "Authorization", valueFormat });
  });

  it("refuses an empty or overlong name", () => {
    refusal({ name: "  \u200B " });
  });

  it("refuses a non-https docs URL and an overlong reason", () => {
    refusal({ docsUrl: "http://docs.acmecrm.io" });
    refusal({ docsUrl: "javascript:alert(1)" });
    refusal({ reason: "x".repeat(1001) });
  });

  it("clamps a long reason to 500", () => {
    const r = customConnectionProposalSchema.parse({
      ...good,
      reason: "y".repeat(800),
    });
    expect(r.reason).toHaveLength(500);
  });

  it("refuses a path that doesn't start with / or carries whitespace", () => {
    refusal({ pathPattern: "v1" });
    refusal({ pathPattern: "/v1 /x" });
  });
});

describe("registrable domains", () => {
  it("names the owner of a host or wildcard", () => {
    expect(registrableDomainOf("api.acmecrm.io")).toBe("acmecrm.io");
    expect(registrableDomainOf("*.eu.acmecrm.io")).toBe("acmecrm.io");
    expect(registrableDomainOf("api.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomainOf("localhost")).toBeNull();
    expect(registrableDomainOf("127.0.0.1")).toBeNull();
  });

  it.each([
    ["printer.home.arpa"],
    ["x.onion"],
    ["api.test"],
    ["svc.local"],
    ["x.localhost"],
    ["x.alt"],
  ])("treats the special-use name %s as non-public", (host) => {
    expect(registrableDomainOf(host)).toBeNull();
    refusal({ hostPattern: host });
  });
});

describe("customConnectionApproveSchema", () => {
  it("takes exactly a non-empty single-line value", () => {
    expect(
      customConnectionApproveSchema.safeParse({ value: "k" }).success,
    ).toBe(true);
    expect(
      customConnectionApproveSchema.safeParse({ value: "  " }).success,
    ).toBe(false);
    expect(customConnectionApproveSchema.safeParse({}).success).toBe(false);
    expect(
      customConnectionApproveSchema.safeParse({ value: "a\nb" }).success,
    ).toBe(false);
    expect(
      customConnectionApproveSchema.safeParse({ value: "k", extra: 1 }).success,
    ).toBe(false);
  });
});
