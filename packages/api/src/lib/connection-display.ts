// Pure, dependency-free display helpers for app connections. Client
// components import these, so this module must never import the DB, the
// crypto provider, or any service graph; keep it leaf-only. That includes
// the @onecli/agent-protocol barrel (it reaches `node:crypto`): the shared
// hostname predicate comes from its leaf `./text` subpath.

import { isBareHostname } from "@onecli/agent-protocol/text";

/** A JSON column as a plain object, or null for any other JSON shape. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
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
