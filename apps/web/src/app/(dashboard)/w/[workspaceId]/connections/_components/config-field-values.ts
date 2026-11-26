import type { OAuthConfigField } from "@onecli/api/apps/types";

/**
 * The value a config field currently holds: what the user entered, else the
 * field's declared default (only `options` fields declare one), else empty.
 * Both config surfaces resolve through this so an untouched segmented control
 * still counts as filled and still reaches the save payload.
 */
export const resolveConfigValue = (
  field: OAuthConfigField,
  values: Record<string, string>,
): string => values[field.name] ?? field.defaultValue ?? "";

/** The body to save: every field, defaults folded in. */
export const buildConfigPayload = (
  fields: OAuthConfigField[],
  values: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    fields.map((f) => [f.name, resolveConfigValue(f, values)]),
  );
