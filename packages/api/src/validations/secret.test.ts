import { describe, expect, it } from "vitest";

import {
  createSecretSchema,
  detectAnthropicAuthMode,
  hostPatternSchema,
  injectionConfigSchema,
  isAnthropicAdminKey,
  isOpenaiAdminKey,
  isPathInjection,
  isPathRegexInjection,
  isPathSafeValue,
  isPathTemplateInjection,
  looksLikeAnthropicKey,
  looksLikeOpenaiKey,
  wildcardCoversPublicSuffix,
} from "./secret";

const accepts = (host: string) => hostPatternSchema.safeParse(host).success;

// Unicode whitespace that String.prototype.trim() strips but that is NOT the
// ASCII space the schema rejects: a non-breaking space and an ideographic space.
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

describe("secret host pattern validation", () => {
  // Exact hosts, and a wildcard over a single registrable domain, are fine.
  it.each([
    "api.github.com",
    "*.example.com",
    "*.amazonaws.com",
    "*.internal", // unknown/custom TLD — left to the operator
  ])("accepts %s", (host) => {
    expect(accepts(host)).toBe(true);
  });

  // A wildcard that spans a public suffix would inject the credential across
  // many unrelated owners — ICANN suffixes and PSL private-section (per-tenant)
  // suffixes alike — so it is rejected.
  it.each(["*.com", "*.io", "*.co.uk", "*.s3.amazonaws.com", "*.github.io"])(
    "rejects public-suffix wildcard %s",
    (host) => {
      expect(accepts(host)).toBe(false);
    },
  );

  // Validation runs on the trimmed value (the service trims on save), so
  // trailing Unicode whitespace must not smuggle a public-suffix wildcard past
  // the check, nor reject an otherwise-valid pattern.
  it("validates the trimmed host pattern", () => {
    expect(accepts("*.com" + NBSP)).toBe(false); // trims to "*.com"
    expect(accepts("*.s3.amazonaws.com" + IDEOGRAPHIC_SPACE)).toBe(false);
    expect(accepts("*.example.com" + NBSP)).toBe(true); // trims to "*.example.com"
  });

  // Malformed wildcard shapes stay rejected (bare, mid-string, multiple).
  it.each(["*", "api.*.com", "*.*.com"])(
    "rejects malformed wildcard %s",
    (host) => {
      expect(accepts(host)).toBe(false);
    },
  );
});

describe("wildcardCoversPublicSuffix", () => {
  it("is true only for a wildcard spanning a public suffix", () => {
    expect(wildcardCoversPublicSuffix("*.com")).toBe(true);
    expect(wildcardCoversPublicSuffix("*.s3.amazonaws.com")).toBe(true);
    expect(wildcardCoversPublicSuffix("*.example.com")).toBe(false);
    expect(wildcardCoversPublicSuffix("*.amazonaws.com")).toBe(false);
    expect(wildcardCoversPublicSuffix("api.github.com")).toBe(false);
  });
});

const acceptsConfig = (injectionConfig: unknown) =>
  createSecretSchema.safeParse({
    name: "Telegram Bot Token",
    type: "generic",
    hostPattern: "api.telegram.org",
    value: "123456:ABC-DEF",
    injectionConfig,
  }).success;

describe("path injection config validation", () => {
  it("accepts a path template with one {value}", () => {
    expect(acceptsConfig({ pathTemplate: "/bot{value}" })).toBe(true);
  });

  it("accepts a path regex with a {value} replacement", () => {
    expect(
      acceptsConfig({
        pathRegex: "^/bot[^/]+(/.*)?$",
        pathReplacement: "/bot{value}$1",
      }),
    ).toBe(true);
  });

  it.each([
    ["template without {value}", { pathTemplate: "/bot" }],
    ["template with two {value}", { pathTemplate: "/{value}/{value}" }],
    ["template not starting with /", { pathTemplate: "bot{value}" }],
    ["extra key (strict)", { pathTemplate: "/bot{value}", extra: "x" }],
    [
      "regex replacement missing {value}",
      { pathRegex: "^/bot.+$", pathReplacement: "/bot$1" },
    ],
    [
      "invalid regex",
      { pathRegex: "[unclosed", pathReplacement: "/bot{value}" },
    ],
  ])("rejects %s", (_name, config) => {
    expect(acceptsConfig(config)).toBe(false);
  });
});

describe("injection config type guards", () => {
  it("classifies path template and regex configs", () => {
    expect(isPathTemplateInjection({ pathTemplate: "/bot{value}" })).toBe(true);
    expect(isPathRegexInjection({ pathRegex: "x", pathReplacement: "y" })).toBe(
      true,
    );
    expect(isPathInjection({ pathTemplate: "/bot{value}" })).toBe(true);
    expect(isPathInjection({ pathRegex: "x", pathReplacement: "y" })).toBe(
      true,
    );
    expect(isPathInjection({ headerName: "Authorization" })).toBe(false);
    expect(isPathInjection(null)).toBe(false);
  });
});

// The secret create/update schemas embed this exact union, so this proves
// param- and path-injected secret configs are accepted end to end.
describe("injectionConfigSchema (the shared injection-config union)", () => {
  it.each([
    ["header", { headerName: "Authorization", valueFormat: "Bearer {value}" }],
    ["param", { paramName: "api_key", paramFormat: "{value}" }],
    ["path template", { pathTemplate: "/bot{value}" }],
    [
      "path regex",
      { pathRegex: "^/bot[^/]+$", pathReplacement: "/bot{value}" },
    ],
    ["null", null],
  ])("accepts a %s config", (_name, config) => {
    expect(injectionConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe("isPathSafeValue", () => {
  it("accepts a Telegram-style token", () => {
    expect(isPathSafeValue("123456:ABC-DEF1234ghIkl-zyx_57W2")).toBe(true);
  });

  it.each([
    ["slash", "a/b"],
    ["question mark", "a?b"],
    ["hash", "a#b"],
    ["percent", "a%b"],
    ["space", "a b"],
  ])("rejects a value containing a %s", (_name, value) => {
    expect(isPathSafeValue(value)).toBe(false);
  });

  it("rejects tab, control, and DEL characters", () => {
    expect(isPathSafeValue("a" + String.fromCharCode(0x09) + "b")).toBe(false);
    expect(isPathSafeValue("a" + String.fromCharCode(0x07) + "b")).toBe(false);
    expect(isPathSafeValue("a" + String.fromCharCode(0x7f) + "b")).toBe(false);
  });
});

// Synthetic, obviously-fake bodies at realistic lengths: the prefixes are the
// documented ones (Claude Platform "Authentication" / "Admin API keys",
// Claude Code "Authentication", OpenAI key types); the bodies are filler.
const body = (n: number) => "x".repeat(n);

describe("Anthropic credential kinds", () => {
  it.each([
    ["a Console API key", `sk-ant-api03-${body(90)}`, "api-key"],
    [
      "a claude setup-token subscription token",
      `sk-ant-oat01-${body(90)}`,
      "oauth",
    ],
    ["an Admin API key", `sk-ant-admin01-${body(90)}`, null],
    ["an OpenAI key", `sk-proj-${body(90)}`, null],
  ] as const)("classifies %s", (_name, value, mode) => {
    expect(detectAnthropicAuthMode(value)).toBe(mode);
    expect(looksLikeAnthropicKey(value)).toBe(mode !== null);
  });

  it("flags a Console Admin key: it can't call models, so it is never a usable key", () => {
    const admin = `sk-ant-admin01-${body(90)}`;
    expect(isAnthropicAdminKey(admin)).toBe(true);
    expect(looksLikeAnthropicKey(admin)).toBe(false);
  });

  it.each([
    ["a Console inference key", `sk-ant-api03-${body(90)}`],
    ["a subscription token", `sk-ant-oat01-${body(90)}`],
    // Shared by older inference keys and Enterprise admin keys: ambiguous, so
    // never warned about as admin.
    ["an `api01` key", `sk-ant-api01-${body(90)}`],
  ])("never flags %s as an admin key", (_n, v) => {
    expect(isAnthropicAdminKey(v)).toBe(false);
  });

  it("treats a truncated paste as the right kind but not a usable key", () => {
    expect(detectAnthropicAuthMode("sk-ant-oat01-abc")).toBe("oauth");
    expect(looksLikeAnthropicKey("sk-ant-oat01-abc")).toBe(false);
  });
});

describe("OpenAI key kinds", () => {
  it.each([
    ["a project key", `sk-proj-${body(90)}`],
    ["a service account key", `sk-svcacct-${body(90)}`],
    ["a legacy user key", `sk-${body(48)}`],
  ])("accepts %s", (_name, value) => {
    expect(looksLikeOpenaiKey(value)).toBe(true);
  });

  it.each([
    ["an Admin key (it can't call models)", `sk-admin-${body(90)}`],
    ["an Anthropic key", `sk-ant-api03-${body(90)}`],
    ["a truncated paste", "sk-proj-abc"],
  ])("rejects %s", (_name, value) => {
    expect(looksLikeOpenaiKey(value)).toBe(false);
  });

  it("recognizes the Admin key prefix", () => {
    expect(isOpenaiAdminKey(`sk-admin-${body(90)}`)).toBe(true);
    expect(isOpenaiAdminKey(`sk-proj-${body(90)}`)).toBe(false);
  });
});
