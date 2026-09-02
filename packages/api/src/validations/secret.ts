import { parse } from "tldts";
import { z } from "zod";

// Best-effort write-time check that a path-injection regex is syntactically
// valid. The gateway's Rust `regex` crate is the authoritative validator (its
// syntax differs slightly), so a pattern accepted here but rejected there just
// skips at inject time rather than corrupting a request.
const isValidRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const headerInjectionSchema = z
  .object({
    headerName: z.string().min(1),
    valueFormat: z.string().optional(),
  })
  .strict();

const paramInjectionSchema = z
  .object({
    paramName: z.string().min(1),
    paramFormat: z.string().optional(),
  })
  .strict();

// URL-path injection (template mode): the secret is substituted into the
// `{value}` hole in the path, e.g. `/bot{value}` for the Telegram Bot API.
const pathTemplateInjectionSchema = z
  .object({
    pathTemplate: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), {
        message: "Path template must start with /",
      })
      .refine((v) => v.split("{value}").length === 2, {
        message: "Path template must contain {value} exactly once",
      }),
  })
  .strict();

// URL-path injection (advanced regex mode): the path is rewritten via a regex;
// `pathReplacement` uses $N capture references and a `{value}` token for the secret.
const pathRegexInjectionSchema = z
  .object({
    pathRegex: z
      .string()
      .min(1)
      .refine((v) => isValidRegex(v), {
        message: "Invalid regular expression",
      }),
    pathReplacement: z
      .string()
      .min(1)
      .refine((v) => v.includes("{value}"), {
        message: "Replacement must include {value} (where the secret goes)",
      }),
  })
  .strict();

export const injectionConfigSchema = z
  .union([
    headerInjectionSchema,
    paramInjectionSchema,
    pathTemplateInjectionSchema,
    pathRegexInjectionSchema,
  ])
  .nullable()
  .optional();

export type HeaderInjectionConfig = z.infer<typeof headerInjectionSchema>;
export type ParamInjectionConfig = z.infer<typeof paramInjectionSchema>;
export type PathTemplateInjectionConfig = z.infer<
  typeof pathTemplateInjectionSchema
>;
export type PathRegexInjectionConfig = z.infer<typeof pathRegexInjectionSchema>;
export type InjectionConfig =
  | HeaderInjectionConfig
  | ParamInjectionConfig
  | PathTemplateInjectionConfig
  | PathRegexInjectionConfig;

export const isHeaderInjection = (
  config: unknown,
): config is HeaderInjectionConfig =>
  config !== null &&
  typeof config === "object" &&
  "headerName" in config &&
  typeof (config as Record<string, unknown>).headerName === "string";

export const isParamInjection = (
  config: unknown,
): config is ParamInjectionConfig =>
  config !== null &&
  typeof config === "object" &&
  "paramName" in config &&
  typeof (config as Record<string, unknown>).paramName === "string";

export const isPathTemplateInjection = (
  config: unknown,
): config is PathTemplateInjectionConfig =>
  config !== null &&
  typeof config === "object" &&
  "pathTemplate" in config &&
  typeof (config as Record<string, unknown>).pathTemplate === "string";

export const isPathRegexInjection = (
  config: unknown,
): config is PathRegexInjectionConfig =>
  config !== null &&
  typeof config === "object" &&
  "pathRegex" in config &&
  typeof (config as Record<string, unknown>).pathRegex === "string";

export const isPathInjection = (
  config: unknown,
): config is PathTemplateInjectionConfig | PathRegexInjectionConfig =>
  isPathTemplateInjection(config) || isPathRegexInjection(config);

// Mirror of the gateway's `is_path_safe` (apps/gateway/crates/inject/src/lib.rs): a path
// secret is substituted into the URL path verbatim, so a path-structural
// delimiter, percent sign, whitespace, or control character in the value would
// reshape the request. The gateway is the authoritative guard (it also covers
// 1Password-sourced values unknown at write time); this gives inline values
// immediate feedback at write time.
export const isPathSafeValue = (value: string): boolean =>
  ![...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (
      "/?#% ".includes(ch) || code < 0x20 || (code >= 0x7f && code <= 0x9f)
    );
  });

/**
 * The wildcard shape a host pattern may take, shared by every surface that
 * accepts one (secrets and policy-rule network targets). Returns `null` when
 * the pattern is acceptable, or a human-readable reason when it is not.
 *
 * Two rules, each guarding a way a credential could reach a host its owner
 * never intended:
 *
 * 1. **A `*` must be a whole label.** `ap*.example.com` is refused — a
 *    partial-label wildcard reads as far narrower than it actually is.
 * 2. **Every label after the first `*` must be literal.** This is the
 *    important one: the suffix is what names WHO you are talking to.
 *    `*.notion.*` spans every TLD — `notion.so`, `notion.com`, and equally
 *    `notion.xyz`, which anyone can register — and `api.*.com` spans every
 *    `.com` domain. Pinning the whole tail means a pattern always resolves to
 *    one owner's namespace, and it lets `wildcardCoversPublicSuffix` (the real
 *    PSL check) reason about a fixed suffix rather than a moving one.
 *
 * Interior wildcards ARE permitted as long as that holds, which is what makes
 * `*.s3.*.amazonaws.com` (a virtual-hosted bucket in any region) expressible:
 * every label after the LAST `*` is literal, and `s3.…` sits between the two.
 * The gateway matches those label-by-label — see `hostMatches`.
 */
const countStars = (value: string): number => {
  let n = 0;
  for (const ch of value) if (ch === "*") n += 1;
  return n;
};

export const wildcardShapeError = (hostPattern: string): string | null => {
  if (!hostPattern.includes("*")) return null;
  const labels = hostPattern.split(".");
  // Partial-label wildcards are legal in the single-`*` regime (that matcher is
  // a prefix/suffix split, so `*-aiplatform.googleapis.com` is meaningful), but
  // NOT once a second `*` appears: there, labels are the matching unit.
  if (
    countStars(hostPattern) >= 2 &&
    labels.some((label) => label.includes("*") && label !== "*")
  ) {
    return "With more than one wildcard, each must stand in for a whole label (e.g. *.s3.*.amazonaws.com)";
  }
  // Rule 2: every label AFTER the last wildcard must be literal, and that tail
  // must name something — never empty. The tail is what identifies WHO the
  // credential is sent to, so `*.notion.*` (tail: nothing) is refused.
  //
  // How much tail is enough is deliberately NOT decided here: a leading-`*`
  // pattern hands that to `wildcardCoversPublicSuffix`, which uses the real
  // PSL and so accepts `*.example.com` and `*.internal` while refusing `*.com`.
  // This check owns only the shape; that one owns the ownership question.
  const lastStar = labels.lastIndexOf("*");
  const literalTail = labels.slice(lastStar + 1);
  if (literalTail.length === 0) {
    return "A host pattern must end in a literal domain (e.g. *.example.com or *.s3.*.amazonaws.com), never a wildcard";
  }
  // An INTERIOR wildcard (`api.*.com`, `*.s3.*.amazonaws.com`) escapes the
  // leading-`*` shape `wildcardCoversPublicSuffix` recognises, so the same
  // public-suffix question is asked here against the pattern's own tail:
  // `api.*.com` leaves only "com" — a suffix, not an owner — and is refused,
  // while `*.s3.*.amazonaws.com` leaves "amazonaws.com" and passes.
  if (
    lastStar > 0 &&
    wildcardCoversPublicSuffix(`*.${literalTail.join(".")}`)
  ) {
    return "A wildcard can't cover a public suffix like *.com; the labels after the wildcard must name a domain, e.g. *.s3.*.amazonaws.com";
  }
  return null;
};

// A secret's host pattern decides which hosts its credential is injected into.
// A "*.X" wildcard is safe only when X is a single registrable domain; a wildcard
// over a public suffix ("*.com", "*.s3.amazonaws.com") would inject the credential
// across many unrelated owners. Returns true for that over-broad case.
export const wildcardCoversPublicSuffix = (hostPattern: string): boolean => {
  if (!hostPattern.startsWith("*.")) return false;
  const { domain, isIcann, isPrivate } = parse(hostPattern.slice(2), {
    allowPrivateDomains: true,
  });
  return domain === null && (isIcann === true || isPrivate === true);
};

export const hostPatternSchema = z
  .string()
  // Trim before validating so the refines see exactly what gets stored: the
  // service also trims on save, so trailing Unicode whitespace must not smuggle
  // a public-suffix wildcard ("*.com " -> stored "*.com") past the checks.
  .trim()
  .min(1, "Host pattern is required")
  .max(1000)
  .refine((v) => !v.includes("://"), {
    message: "Enter a hostname, not a URL (remove http:// or https://)",
  })
  .refine((v) => !v.includes("/"), {
    message:
      "Enter a hostname only, not a path (use the path pattern field for paths)",
  })
  .refine((v) => !v.includes(" "), {
    message: "Host pattern must not contain spaces",
  })
  // A credential is injected into every host its pattern matches, so the
  // wildcard shape is constrained (see `wildcardShapeError` for the rules and
  // the reasoning). The message comes from the shared helper so the secret
  // form and the policy-rule form explain the same rule the same way.
  .refine((v) => wildcardShapeError(v) === null, {
    message:
      "Wildcards must stand in for whole labels and the pattern must end in a literal domain, e.g. *.example.com or *.s3.*.amazonaws.com",
  })
  // ...and that wildcard must not cover a whole public suffix (see helper above).
  .refine((v) => !wildcardCoversPublicSuffix(v), {
    message:
      "A wildcard can't cover a public suffix like *.com; use a specific domain, e.g. *.example.com",
  });

export const valueSources = ["inline", "onepassword"] as const;

// 1Password secret reference, op://vault/item/field (>= 3 path segments).
const opRefSchema = z
  .string()
  .min(1)
  .refine(
    (v) =>
      v.startsWith("op://") &&
      v.slice(5).split("/").filter(Boolean).length >= 3,
    { message: "Must be a 1Password reference (op://vault/item/field)" },
  );

// Human-readable labels of the picked vault/item/field, for display only.
const opDisplaySchema = z
  .object({ vault: z.string(), item: z.string(), field: z.string() })
  .optional();

export const createSecretSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    type: z.enum(["anthropic", "openai", "generic"]),
    valueSource: z.enum(valueSources).optional(),
    value: z.string().max(10000).optional(),
    opRef: opRefSchema.optional(),
    opDisplay: opDisplaySchema,
    hostPattern: hostPatternSchema,
    pathPattern: z.string().max(1000).optional(),
    injectionConfig: injectionConfigSchema,
  })
  .superRefine((data, ctx) => {
    if (data.valueSource === "onepassword") {
      if (!data.opRef) {
        ctx.addIssue({
          code: "custom",
          path: ["opRef"],
          message: "Select a 1Password field",
        });
      }
    } else if (!data.value || data.value.length < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Secret value is required",
      });
    }
  });

export type CreateSecretInput = z.infer<typeof createSecretSchema>;

export const updateSecretSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    valueSource: z.enum(valueSources).optional(),
    value: z.string().max(10000).optional(),
    opRef: opRefSchema.optional(),
    opDisplay: opDisplaySchema,
    hostPattern: hostPatternSchema.optional(),
    pathPattern: z.string().max(1000).nullable().optional(),
    injectionConfig: injectionConfigSchema,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  })
  .superRefine((data, ctx) => {
    if (data.valueSource === "onepassword" && !data.opRef) {
      ctx.addIssue({
        code: "custom",
        path: ["opRef"],
        message: "Select a 1Password field",
      });
    }
    if (
      data.valueSource === "inline" &&
      (!data.value || data.value.length < 1)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Secret value is required",
      });
    }
  });

export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;

export const ANTHROPIC_KEY_MIN_LENGTH = 40;

export const anthropicAuthModes = ["api-key", "oauth"] as const;
export type AnthropicAuthMode = (typeof anthropicAuthModes)[number];

export interface AnthropicSecretMetadata {
  authMode: AnthropicAuthMode;
}

export const detectAnthropicAuthMode = (
  value: string,
): AnthropicAuthMode | null => {
  if (value.startsWith("sk-ant-api")) return "api-key";
  if (value.startsWith("sk-ant-oat")) return "oauth";
  return null;
};

export const looksLikeAnthropicKey = (value: string): boolean =>
  detectAnthropicAuthMode(value) !== null &&
  value.length >= ANTHROPIC_KEY_MIN_LENGTH;

export const parseAnthropicMetadata = (
  metadata: unknown,
): AnthropicSecretMetadata | null => {
  if (
    metadata &&
    typeof metadata === "object" &&
    "authMode" in metadata &&
    anthropicAuthModes.includes(
      (metadata as { authMode: string }).authMode as AnthropicAuthMode,
    )
  ) {
    return metadata as AnthropicSecretMetadata;
  }
  return null;
};

export const OPENAI_KEY_MIN_LENGTH = 40;

export const looksLikeOpenaiKey = (value: string): boolean =>
  value.startsWith("sk-") &&
  !value.startsWith("sk-ant-") &&
  value.length >= OPENAI_KEY_MIN_LENGTH;

export const openaiAuthModes = ["api-key", "oauth"] as const;
export type OpenaiAuthMode = (typeof openaiAuthModes)[number];

export interface OpenaiOAuthJson {
  auth_mode?: string;
  tokens: {
    id_token?: string | null;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface OpenaiSecretMetadata {
  authMode: OpenaiAuthMode;
  accountId?: string;
}

export const parseOpenaiOAuthJson = (value: string): OpenaiOAuthJson | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    if (
      tokens &&
      typeof tokens.access_token === "string" &&
      typeof tokens.refresh_token === "string"
    ) {
      return parsed as unknown as OpenaiOAuthJson;
    }
    return null;
  } catch {
    return null;
  }
};

export interface OpenaiApiKeyJson {
  auth_mode: "apikey";
  OPENAI_API_KEY: string;
}

export const parseOpenaiApiKeyJson = (
  value: string,
): OpenaiApiKeyJson | null => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.auth_mode === "apikey" &&
      typeof parsed.OPENAI_API_KEY === "string" &&
      parsed.OPENAI_API_KEY.length > 0
    ) {
      return parsed as unknown as OpenaiApiKeyJson;
    }
    return null;
  } catch {
    return null;
  }
};

export const parseOpenaiAuthJson = (
  value: string,
): { mode: OpenaiAuthMode; apiKey?: string } | null => {
  const oauth = parseOpenaiOAuthJson(value);
  if (oauth) return { mode: "oauth" };
  const apiKey = parseOpenaiApiKeyJson(value);
  if (apiKey) return { mode: "api-key", apiKey: apiKey.OPENAI_API_KEY };
  return null;
};

export const parseOpenaiMetadata = (
  metadata: unknown,
): OpenaiSecretMetadata | null => {
  if (
    metadata &&
    typeof metadata === "object" &&
    "authMode" in metadata &&
    openaiAuthModes.includes(
      (metadata as { authMode: string }).authMode as OpenaiAuthMode,
    )
  ) {
    return metadata as OpenaiSecretMetadata;
  }
  return null;
};

export const detectOpenaiAuthMode = (value: string): OpenaiAuthMode =>
  parseOpenaiOAuthJson(value) !== null ? "oauth" : "api-key";

/**
 * The subset of {@link wildcardShapeError} that applies to a POLICY-RULE
 * network target, which is a different animal from a secret's host pattern.
 *
 * A network target only ever DECIDES (allow/block/ask); it never selects a
 * credential, so the breadth that would be reckless on a secret is legitimate
 * here — a bare `*` is the universal deny-all fence the overlap checker knows
 * by name (`isUniversal`), and a broad block is a safety feature.
 *
 * What still must not slip through is a pattern whose SHAPE the matcher cannot
 * honour: a partial-label wildcard, or a trailing wildcard that would let an
 * ALLOW rule span every TLD. Those are refused for the same reason as on a
 * secret. Everything broad-but-well-formed stays allowed.
 */
export const networkHostPatternShapeError = (
  hostPattern: string,
): string | null => {
  if (!hostPattern.includes("*")) return null;
  if (hostPattern === "*") return null; // the universal fence — deliberate
  const labels = hostPattern.split(".");
  // A trailing wildcard spans every TLD, so it can never name who it trusts.
  if (labels[labels.length - 1] === "*") {
    return "A host pattern must end in a literal domain (e.g. *.example.com), never a wildcard";
  }
  // The partial-label rule applies ONLY in the multi-wildcard regime, where
  // labels are the matching unit. A single-`*` pattern is a prefix/suffix split
  // that legitimately cuts mid-label — `*-aiplatform.googleapis.com` is how
  // Vertex AI's regional hosts are expressed, and narrowing that would break a
  // shipped integration.
  if (
    countStars(hostPattern) >= 2 &&
    labels.some((label) => label.includes("*") && label !== "*")
  ) {
    return "With more than one wildcard, each must stand in for a whole label (e.g. *.s3.*.amazonaws.com)";
  }
  return null;
};
