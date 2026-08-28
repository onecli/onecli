/**
 * Derive a valid agent identifier from a display name — the same rule both
 * create flows (byo and hosted) use, matching the server's
 * `/^[a-z0-9][a-z0-9-]{0,49}$/`.
 */
export const nameToIdentifier = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
