/** Collapse Node's `string | string[] | undefined` header bag to lowercase strings. */
export const flattenHeaders = (
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value))
      headers[key.toLowerCase()] = value.join(", ");
  }
  return headers;
};
