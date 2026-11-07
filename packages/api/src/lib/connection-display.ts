// Pure, dependency-free display helpers for app connections. Client
// components import these, so this module must never import the DB, the
// crypto provider, or any service graph; keep it leaf-only. That includes
// the @onecli/agent-protocol barrel (it reaches `node:crypto`): the shared
// hostname predicate comes from its leaf `./text` subpath.

import { isBareHostname } from "@onecli/agent-protocol/text";

/** A JSON column as a plain object, or null for any other JSON shape. */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The human label for a connection: email, else username, else name. */
export const extractLabel = (
  metadata?: Record<string, unknown>,
): string | null => {
  const email = metadata?.email;
  const username = metadata?.username;
  const name = metadata?.name;
  if (typeof email === "string" && email) return email;
  if (typeof username === "string" && username) return username;
  if (typeof name === "string" && name) return name;
  return null;
};

/**
 * The label a reconnect writes. A name the user chose (it differs from what
 * the provider called the old account) survives. A provider-derived name
 * follows the account now signed in, so a different account never wears the
 * old one's name. No new identity (a bare token persist) keeps the label.
 */
export const reconnectLabel = (
  existing: { label: string | null; metadata: unknown },
  metadata: Record<string, unknown> | undefined,
): string | null => {
  const fresh = extractLabel(metadata);
  if (!fresh) return existing.label;
  const previous = extractLabel(asRecord(existing.metadata) ?? undefined);
  const renamedByUser = existing.label !== null && existing.label !== previous;
  return renamedByUser ? existing.label : fresh;
};

/**
 * The short tags a connection shows beside its name (a GitHub App's repos, a
 * provider region), from non-secret metadata of any JSON shape.
 */
export const connectionTags = (metadata: unknown): string[] => {
  const raw = asRecord(metadata)?.tags;
  return Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : [];
};

/** Where a database connection points: its non-secret connect fields. */
export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
  username: string;
}

/** The metadata key a database connection records its target under. */
export const DATABASE_TARGET_METADATA_KEY = "target";

/** The TLS modes the gateway dials a database with (`dbproxy::TlsMode`).
 *  `disable` is an explicit choice for a server with SSL off. */
export const DATABASE_TLS_MODES = [
  "verify-full",
  "require",
  "disable",
] as const;
export type DatabaseTlsMode = (typeof DATABASE_TLS_MODES)[number];

/** The tag each TLS mode records on a database connection, which every
 *  card reads. One table, so the form, the cards and a reconnect agree. */
export const DATABASE_TLS_TAGS: Record<DatabaseTlsMode, string> = {
  "verify-full": "TLS verified",
  require: "TLS",
  disable: "No TLS",
};

/** The TLS mode a database connection was saved with, read back from its
 *  tags; null for a connection without one. */
export const databaseTlsModeFromTags = (
  tags: readonly string[],
): DatabaseTlsMode | null =>
  DATABASE_TLS_MODES.find((mode) => tags.includes(DATABASE_TLS_TAGS[mode])) ??
  null;

/**
 * A database connection's target from non-secret metadata of any JSON shape,
 * or null (an older connection saved before the target was recorded).
 */
export const extractDatabaseTarget = (
  metadata: unknown,
): DatabaseTarget | null => {
  const raw = asRecord(asRecord(metadata)?.[DATABASE_TARGET_METADATA_KEY]);
  if (!raw) return null;
  const { host, port, database, username } = raw;
  if (
    typeof host !== "string" ||
    !host ||
    typeof port !== "number" ||
    typeof database !== "string" ||
    !database ||
    typeof username !== "string"
  )
    return null;
  return { host, port, database, username };
};

/** `<database> on <host>`: the name PostgreSQL connections were given before
 *  short names (and the label request logs snapshot). The host must be a
 *  dotted hostname or an IP literal, so a name a user typed (`Sales on prod`)
 *  is never mistaken for one. One pattern, so every reader agrees. */
const LEGACY_DB_NAME =
  /^(.+) on ((?:[a-z0-9-]+\.)+[a-z0-9-]+|[0-9a-f]*:[0-9a-f:.]*(?:%[a-z0-9]+)?)$/i;

/** The database and host in a legacy generated name, or null. */
export const parseLegacyDatabaseName = (
  name: unknown,
): { database: string; host: string } | null => {
  if (typeof name !== "string") return null;
  const match = LEGACY_DB_NAME.exec(name);
  return match?.[1] && match[2] ? { database: match[1], host: match[2] } : null;
};

/** The name to show for a connection: its label, except that a database's
 *  generated `<db> on <host>` (connections saved before short names) reads
 *  as just the database. */
export const displayConnectionLabel = (
  label: string | null,
  metadata: unknown,
): string | null => {
  if (!label) return label;
  const legacy = parseLegacyDatabaseName(label);
  return legacy && asRecord(metadata)?.name === label ? legacy.database : label;
};

const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

/** The server as a person names it: a hostname's first label
 *  (`orders-prod` for `orders-prod.abc123.example.com`), an IP as is, and
 *  the port only when it isn't the default. The full host lives in the URL. */
export const shortDatabaseServer = (
  { host, port }: Pick<DatabaseTarget, "host" | "port">,
  defaultPort = 5432,
): string => {
  const name = IP_LITERAL.test(host) ? host : (host.split(".")[0] ?? host);
  return port === defaultPort ? name : `${name}:${port}`;
};

/** A copyable connection string, never with a password:
 *  `postgresql://user@host:port/database`. */
export const databaseConnectionUrl = ({
  host,
  port,
  database,
  username,
}: DatabaseTarget): string => {
  const h = host.includes(":") ? `[${host}]` : host;
  const user = username ? `${encodeURIComponent(username)}@` : "";
  return `postgresql://${user}${h}:${port}/${encodeURIComponent(database)}`;
};

/** Two targets are the same database login: same server, database and user. */
const sameDatabaseTarget = (a: DatabaseTarget, b: DatabaseTarget): boolean =>
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.port === b.port &&
  a.database === b.database &&
  a.username === b.username;

/**
 * The existing connection a new connect should update instead of adding a
 * second one. A database is the same connection when it is the same login
 * (server, database, user): its short name alone (`app`) is shared across
 * servers, and matching by name would overwrite another server's connection.
 * Anything else matches by label, else the provider's only account.
 */
export const findDuplicateConnection = <
  T extends { label: string | null; metadata: unknown },
>(
  existing: T[],
  effectiveLabel: string | null,
  metadata: Record<string, unknown> | undefined,
): T | undefined => {
  const target = extractDatabaseTarget(metadata);
  if (target) {
    return existing.find((conn) => {
      const other = extractDatabaseTarget(conn.metadata);
      return other !== null && sameDatabaseTarget(other, target);
    });
  }
  if (!effectiveLabel) return existing[0];
  const wanted = effectiveLabel.toLowerCase().trim();
  return existing.find((conn) => conn.label?.toLowerCase().trim() === wanted);
};

/**
 * Whether a database connection's stored role logs in with superuser powers
 * (a superuser, or a role that can reach the server's own files and
 * programs), as the gateway's database front door last saw it at a session
 * start (`metadata.superuser`). Such a role can reach past the statement
 * checks OneCLI applies, so the dashboard warns about it.
 */
export const connectsAsSuperuser = (metadata: unknown): boolean =>
  asRecord(metadata)?.superuser === true;

/**
 * Host-bound providers: their credential is injected ONLY on one stored
 * tenant host, read by the gateway from this credential field (the gateway
 * rule's `credential_host_field`, `apps/gateway/crates/apps/src/lib.rs`), and
 * only when that host sits in `zone`. `connection-display.parity.test.ts`
 * pins the two tables together.
 */
export const HOST_BOUND_PROVIDERS: Readonly<
  Record<string, { credentialField: string; zone: string }>
> = {
  salesforce: { credentialField: "instance_host", zone: ".my.salesforce.com" },
  snowflake: { credentialField: "host", zone: ".snowflakecomputing.com" },
  "jfrog-artifactory": { credentialField: "subdomain", zone: ".jfrog.io" },
  zendesk: { credentialField: "instance_host", zone: ".zendesk.com" },
};

/**
 * The non-secret metadata key every host-bound connection records its bound
 * host under (the gateway's `BOUND_HOST_METADATA_KEY`), whatever credential
 * field the provider's gate reads. One key, so the dashboard, the agent's
 * instructions and the gateway's wrong-host answer read the same value.
 */
export const BOUND_HOST_METADATA_KEY = "bound_host";

/** A pasted host / URL reduced to a bare lowercase host (no scheme, path, port). */
const normalizeHost = (raw: string): string => {
  let h = raw.trim().toLowerCase();
  const schemeIdx = h.indexOf("://");
  if (schemeIdx >= 0) h = h.slice(schemeIdx + 3);
  for (const sep of ["/", ":"]) {
    const idx = h.indexOf(sep);
    if (idx >= 0) h = h.slice(0, idx);
  }
  return h;
};

/**
 * The bound host for a new/updated connection of `provider`, derived from
 * the credential field the gateway gates injection on — so what the agent is
 * told is exactly where the token works. `null` for every other provider, or
 * when the stored value is not a bare hostname inside the provider's zone
 * (it is spliced into the agent's instructions as `https://<host>`).
 */
export const deriveBoundHost = (
  provider: string,
  credentials: Record<string, unknown>,
): string | null => {
  const spec = HOST_BOUND_PROVIDERS[provider];
  const raw = spec ? credentials[spec.credentialField] : undefined;
  if (!spec || typeof raw !== "string") return null;
  const host = normalizeHost(raw);
  return isBoundHostIn(host, spec.zone) ? host : null;
};

const isBoundHostIn = (host: string, zone: string): boolean =>
  isBareHostname(host) && host.endsWith(zone) && host.length > zone.length;

/**
 * The tenant host a connection is bound to (a Salesforce org's My Domain, a
 * Snowflake account host, a JFrog instance), from non-secret metadata of any
 * JSON shape. Shown next to the account so a user can tell which tenant the
 * credential belongs to, and stated to the agent so it calls the right host.
 * Only a bare hostname is accepted: the value is rendered as `https://<host>`.
 */
export const extractBoundHost = (metadata: unknown): string | null => {
  const raw = asRecord(metadata)?.[BOUND_HOST_METADATA_KEY];
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase();
  return isBareHostname(host) ? host : null;
};
