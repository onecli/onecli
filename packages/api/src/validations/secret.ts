import { parse } from "tldts";
import { z } from "zod";

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

const injectionConfigSchema = z
  .union([headerInjectionSchema, paramInjectionSchema])
  .nullable()
  .optional();

export type HeaderInjectionConfig = z.infer<typeof headerInjectionSchema>;
export type ParamInjectionConfig = z.infer<typeof paramInjectionSchema>;
export type InjectionConfig = HeaderInjectionConfig | ParamInjectionConfig;

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
  // A credential is injected into every host its pattern matches, so only allow
  // a single leading-subdomain wildcard ("*.example.com"). Reject mid-string
  // ("api.*.com") and bare ("*") wildcards, which would inject into unintended
  // hosts now that the gateway matches a `*` anywhere in the pattern.
  .refine((v) => !v.includes("*") || /^\*\.[a-z0-9.-]+$/i.test(v), {
    message:
      "Wildcards are only allowed as a leading subdomain, e.g. *.example.com",
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
