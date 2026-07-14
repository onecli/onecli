import { describe, expect, it } from "vitest";

import {
  createSecretSchema,
  GOOGLE_SA_DEFAULT_HOST,
  hostPatternSchema,
  injectionConfigSchema,
  isPathInjection,
  isPathRegexInjection,
  isPathSafeValue,
  isPathTemplateInjection,
  parseGoogleServiceAccountJson,
  parseGoogleServiceAccountMetadata,
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

// migrate-import.ts validates incoming secrets with this exact union, so this
// proves param- and path-injected secrets survive an org->project migration.
describe("injectionConfigSchema (shared union, used by migrate import)", () => {
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

// ── Google Service Account ──

const validSaJson = JSON.stringify({
  type: "service_account",
  project_id: "my-project",
  private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
  client_email: "test@my-project.iam.gserviceaccount.com",
  client_id: "123456789",
});

const saSecretInput = (overrides: Record<string, unknown> = {}) => ({
  name: "Google SA",
  type: "google_service_account" as const,
  hostPattern: "www.googleapis.com",
  value: validSaJson,
  ...overrides,
});

describe("google_service_account schema validation", () => {
  it("accepts a valid SA JSON key", () => {
    expect(createSecretSchema.safeParse(saSecretInput()).success).toBe(true);
  });

  it("rejects non-JSON value", () => {
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: "not-json" }))
        .success,
    ).toBe(false);
  });

  it("rejects SA JSON with wrong type field", () => {
    const wrongType = JSON.stringify({
      ...JSON.parse(validSaJson),
      type: "authorized_user",
    });
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: wrongType })).success,
    ).toBe(false);
  });

  it("rejects SA JSON missing private_key", () => {
    const parsed = JSON.parse(validSaJson) as Record<string, unknown>;
    delete parsed.private_key;
    expect(
      createSecretSchema.safeParse(
        saSecretInput({ value: JSON.stringify(parsed) }),
      ).success,
    ).toBe(false);
  });

  it("rejects SA JSON missing client_email", () => {
    const parsed = JSON.parse(validSaJson) as Record<string, unknown>;
    delete parsed.client_email;
    expect(
      createSecretSchema.safeParse(
        saSecretInput({ value: JSON.stringify(parsed) }),
      ).success,
    ).toBe(false);
  });

  it("rejects SA JSON with empty private_key", () => {
    const empty = JSON.stringify({
      ...JSON.parse(validSaJson),
      private_key: "",
    });
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: empty })).success,
    ).toBe(false);
  });

  it("rejects SA JSON with empty client_email", () => {
    const empty = JSON.stringify({
      ...JSON.parse(validSaJson),
      client_email: "",
    });
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: empty })).success,
    ).toBe(false);
  });

  it("rejects SA JSON with whitespace-only private_key", () => {
    const ws = JSON.stringify({
      ...JSON.parse(validSaJson),
      private_key: "   ",
    });
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: ws })).success,
    ).toBe(false);
  });

  it("rejects SA JSON with whitespace-only client_email", () => {
    const ws = JSON.stringify({
      ...JSON.parse(validSaJson),
      client_email: "   ",
    });
    expect(
      createSecretSchema.safeParse(saSecretInput({ value: ws })).success,
    ).toBe(false);
  });

  it("skips SA JSON validation for 1Password source", () => {
    expect(
      createSecretSchema.safeParse(
        saSecretInput({
          valueSource: "onepassword",
          opRef: "op://vault/item/field",
        }),
      ).success,
    ).toBe(true);
  });

  it("defaults hostPattern to GOOGLE_SA_DEFAULT_HOST when omitted", () => {
    const input = saSecretInput();
    delete (input as Record<string, unknown>).hostPattern;
    const result = createSecretSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hostPattern).toBe("www.googleapis.com");
    }
  });

  it("preserves explicit hostPattern override", () => {
    const result = createSecretSchema.safeParse(
      saSecretInput({ hostPattern: "storage.googleapis.com" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hostPattern).toBe("storage.googleapis.com");
    }
  });

  it("rejects omitted hostPattern for non-SA types", () => {
    expect(
      createSecretSchema.safeParse({
        name: "Generic Secret",
        type: "generic",
        value: "my-token",
        injectionConfig: {
          headerName: "Authorization",
          valueFormat: "Bearer {value}",
        },
      }).success,
    ).toBe(false);
  });
});

describe("GOOGLE_SA_DEFAULT_HOST", () => {
  it("is www.googleapis.com", () => {
    expect(GOOGLE_SA_DEFAULT_HOST).toBe("www.googleapis.com");
  });
});

describe("parseGoogleServiceAccountJson", () => {
  it("parses valid SA JSON", () => {
    const result = parseGoogleServiceAccountJson(validSaJson);
    expect(result).not.toBeNull();
    expect(result!.client_email).toBe(
      "test@my-project.iam.gserviceaccount.com",
    );
    expect(result!.project_id).toBe("my-project");
  });

  it("returns null for non-JSON", () => {
    expect(parseGoogleServiceAccountJson("not-json")).toBeNull();
  });

  it("returns null when type is not service_account", () => {
    expect(
      parseGoogleServiceAccountJson(
        JSON.stringify({ ...JSON.parse(validSaJson), type: "authorized_user" }),
      ),
    ).toBeNull();
  });

  it("returns null when private_key is missing", () => {
    const parsed = JSON.parse(validSaJson) as Record<string, unknown>;
    delete parsed.private_key;
    expect(parseGoogleServiceAccountJson(JSON.stringify(parsed))).toBeNull();
  });
});

describe("parseGoogleServiceAccountMetadata", () => {
  it("parses valid metadata", () => {
    const result = parseGoogleServiceAccountMetadata({
      clientEmail: "test@example.iam.gserviceaccount.com",
      projectId: "my-project",
    });
    expect(result).not.toBeNull();
    expect(result!.clientEmail).toBe("test@example.iam.gserviceaccount.com");
    expect(result!.projectId).toBe("my-project");
  });

  it("returns null for missing clientEmail", () => {
    expect(
      parseGoogleServiceAccountMetadata({ projectId: "my-project" }),
    ).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseGoogleServiceAccountMetadata(null)).toBeNull();
  });
});
