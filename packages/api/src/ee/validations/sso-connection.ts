import { z } from "zod";

const displayName = z.string().trim().min(1).max(100);
const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => v.startsWith("https://"), {
    message: "Must be an https URL",
  });
// Cognito's MetadataFile has its own size cap — verified in dev; keep ours
// comfortably below any transport limit.
const metadataXml = z.string().min(100).max(512_000);

export const createSsoConnectionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("saml"),
      displayName,
      metadataUrl: httpsUrl.optional(),
      metadataXml: metadataXml.optional(),
    })
    .refine((v) => Boolean(v.metadataUrl) !== Boolean(v.metadataXml), {
      message: "Provide exactly one of metadata URL or metadata XML",
    }),
  z.object({
    type: z.literal("oidc"),
    displayName,
    issuer: httpsUrl,
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().min(1).max(1024),
  }),
]);

// Patch: lifecycle + per-type refresh fields. Type switches are rejected in
// the service (ProviderType is immutable in Cognito).
export const updateSsoConnectionSchema = z
  .object({
    displayName: displayName.optional(),
    enabled: z.boolean().optional(),
    metadataUrl: httpsUrl.optional(),
    metadataXml: metadataXml.optional(),
    issuer: httpsUrl.optional(),
    clientId: z.string().trim().min(1).max(256).optional(),
    clientSecret: z.string().min(1).max(1024).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field must be provided",
  })
  .refine((v) => !(v.metadataUrl && v.metadataXml), {
    message: "Provide only one of metadata URL or metadata XML",
  });
