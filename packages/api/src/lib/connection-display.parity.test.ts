import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUND_HOST_METADATA_KEY,
  HOST_BOUND_PROVIDERS,
  deriveBoundHost,
  extractBoundHost,
} from "./connection-display";

// The API writes `metadata.bound_host` from the credential field the GATEWAY
// gates injection on. If the two tables drift, a connection is told one host
// while its token works on another (or on none): the exact failure this key
// exists to prevent. So the gateway's registry source is read and checked.
const GATEWAY_APPS = fileURLToPath(
  new URL("../../../../apps/gateway/crates/apps/src/lib.rs", import.meta.url),
);

/** Every provider's host-gated rule (the `HostRule` carrying a
 *  `credential_host_field`), from the Rust source. */
const gatewayHostBound = (): Record<
  string,
  { credentialField: string; zone: string }
> => {
  const src = readFileSync(GATEWAY_APPS, "utf8");
  const out: Record<string, { credentialField: string; zone: string }> = {};
  for (const block of src.split(/AppProvider \{/).slice(1)) {
    const provider = /provider:\s*"([^"]+)"/.exec(block)?.[1];
    for (const rule of block.split(/HostRule \{/).slice(1)) {
      const field = /credential_host_field:\s*Some\("([^"]+)"\)/.exec(
        rule,
      )?.[1];
      const zone = /HostPattern::Suffix\("([^"]+)"\)/.exec(rule)?.[1];
      if (provider && field && zone) {
        out[provider] = { credentialField: field, zone };
      }
    }
  }
  return out;
};

describe("host-bound providers mirror the gateway's host gate", () => {
  it("same providers, same credential field, same zone", () => {
    const gateway = gatewayHostBound();
    // Guard the parser itself: it must still find the known gates.
    expect(Object.keys(gateway).length).toBeGreaterThanOrEqual(3);
    expect(HOST_BOUND_PROVIDERS).toEqual(gateway);
  });

  it("same metadata key", () => {
    const src = readFileSync(GATEWAY_APPS, "utf8");
    expect(src).toContain(
      `pub const BOUND_HOST_METADATA_KEY: &str = "${BOUND_HOST_METADATA_KEY}";`,
    );
  });
});

describe("deriveBoundHost", () => {
  it("normalizes a pasted URL to the bare host", () => {
    expect(
      deriveBoundHost("snowflake", {
        host: " https://Acme-Prod.snowflakecomputing.com:443/console ",
      }),
    ).toBe("acme-prod.snowflakecomputing.com");
  });

  it("refuses anything outside the provider's zone or not a hostname", () => {
    for (const host of [
      "evil.test",
      "snowflakecomputing.com",
      ".snowflakecomputing.com",
      "evilsnowflakecomputing.com",
      "a b.snowflakecomputing.com",
      "evil.com#x.snowflakecomputing.com",
      "user@acme.snowflakecomputing.com",
    ]) {
      expect(deriveBoundHost("snowflake", { host }), host).toBeNull();
    }
    expect(deriveBoundHost("snowflake", { host: 7 })).toBeNull();
    expect(deriveBoundHost("snowflake", {})).toBeNull();
    // A Salesforce host is not a Snowflake one, and vice versa.
    expect(
      deriveBoundHost("salesforce", { instance_host: "acme.jfrog.io" }),
    ).toBeNull();
  });

  it("is null for providers without a host gate", () => {
    expect(
      deriveBoundHost("github", { host: "acme.snowflakecomputing.com" }),
    ).toBeNull();
  });
});

describe("extractBoundHost", () => {
  it("accepts a bare hostname and rejects anything else", () => {
    expect(extractBoundHost({ bound_host: "Acme.My.Salesforce.com" })).toBe(
      "acme.my.salesforce.com",
    );
    for (const bad of [
      "evil.test/x",
      "javascript:alert(1)",
      "localhost",
      "",
      7,
    ]) {
      expect(extractBoundHost({ bound_host: bad }), String(bad)).toBeNull();
    }
    expect(extractBoundHost(null)).toBeNull();
    expect(extractBoundHost({})).toBeNull();
    // Any JSON column shape is accepted as input; only an object can hold it.
    expect(extractBoundHost(["acme.my.salesforce.com"])).toBeNull();
    expect(extractBoundHost("acme.my.salesforce.com")).toBeNull();
    // The legacy Salesforce-only key is not read: one key, one truth.
    expect(
      extractBoundHost({ instance_host: "acme.my.salesforce.com" }),
    ).toBeNull();
  });
});

// Dashboard client components import these modules, and the
// @onecli/agent-protocol barrel reaches `node:crypto`: client-reachable code
// takes the shared helpers from the leaf `./text` subpath only.
describe("client-reachable display modules stay off the agent-protocol barrel", () => {
  it.each(["./connection-display.ts", "./format.ts"])("%s", (file) => {
    const src = readFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/from "@onecli\/agent-protocol"/);
  });
});
