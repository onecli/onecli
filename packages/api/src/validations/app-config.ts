import { z } from "zod";

const configValuesSchema = z.record(z.string(), z.string());

/**
 * Validate an app-config body against the app's own configurable field
 * definitions — apps declare arbitrary fields (github-app uses
 * appId/appSlug/privateKey, OAuth apps use clientId/clientSecret). Unknown
 * keys are stripped; no field is required here because an empty secret means
 * "keep current" on update — `upsertAppConfig` owns those semantics.
 *
 * Returns null when the body is not a string record.
 */
export const parseConfigBody = (
  body: unknown,
  fields: { name: string }[],
): Record<string, string> | null => {
  const parsed = configValuesSchema.safeParse(body);
  if (!parsed.success) return null;
  const allowed = new Set(fields.map((field) => field.name));
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => allowed.has(key)),
  );
};
