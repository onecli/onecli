import { z } from "zod";

const injectionConfigSchema = z
  .object({
    headerName: z.string().min(1),
    valueFormat: z.string().optional(),
  })
  .nullable()
  .optional();

/** Validates a host pattern is a hostname, not a URL or path. */
const hostPatternSchema = z
  .string()
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
  });

export const createSecretSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(["anthropic", "generic"]),
  value: z.string().min(1).max(10000),
  hostPattern: hostPatternSchema,
  pathPattern: z.string().max(1000).optional(),
  injectionConfig: injectionConfigSchema,
});

export type CreateSecretInput = z.infer<typeof createSecretSchema>;

export const updateSecretSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    value: z.string().min(1).max(10000).optional(),
    hostPattern: hostPatternSchema.optional(),
    pathPattern: z.string().max(1000).nullable().optional(),
    injectionConfig: injectionConfigSchema,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;

// ── Secret metadata ────────────────────────────────────────────────────

export const anthropicAuthModes = ["api-key", "oauth"] as const;
export type AnthropicAuthMode = (typeof anthropicAuthModes)[number];

export interface AnthropicSecretMetadata {
  authMode: AnthropicAuthMode;
}

/** Detect the auth mode from a plaintext Anthropic secret value. */
export const detectAnthropicAuthMode = (value: string): AnthropicAuthMode =>
  value.startsWith("sk-ant-oat") ? "oauth" : "api-key";

/** Type-safe accessor for Anthropic metadata from a Prisma Json field. */
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
