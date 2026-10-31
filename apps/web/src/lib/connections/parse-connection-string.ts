/** The connect-form fields a PostgreSQL connection string fills in. */
export interface ParsedConnectionString {
  fields: Record<string, string>;
  /** The string asked for no encryption: the form selects No encryption,
   *  which is worth saying out loud. */
  plaintextRequested: boolean;
}

/** libpq's sslmode values, onto the modes OneCLI dials with. Only `disable`
 *  forbids TLS; `allow` and `prefer` accept it, so they become Encrypt only
 *  (OneCLI never falls back to plaintext on its own). */
const VERIFYING = new Set(["verify-full", "verify-ca"]);
const PLAINTEXT = "disable";

/**
 * Parse `postgres://user:password@host:port/database?sslmode=...` into the
 * form's own fields. Nothing is stored as a string: the user sees (and can
 * fix) every value it filled. Null for anything that is not such a URL.
 */
export const parseConnectionString = (
  raw: string,
): ParsedConnectionString | null => {
  const input = raw.trim();
  if (!/^postgres(?:ql)?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return null;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const fields: Record<string, string> = { host };
  if (url.port) fields.port = url.port;
  const database = decode(url.pathname.replace(/^\//, ""));
  if (database) fields.database = database;
  if (url.username) fields.username = decode(url.username);
  if (url.password) fields.password = decode(url.password);
  const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
  if (sslmode)
    fields.sslmode = VERIFYING.has(sslmode)
      ? "verify-full"
      : sslmode === PLAINTEXT
        ? "disable"
        : "require";
  return {
    fields,
    plaintextRequested: sslmode === PLAINTEXT,
  };
};
