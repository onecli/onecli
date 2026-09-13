import { createHash } from "node:crypto";
import { Hono } from "hono";
import { EGRESS_IPV4_ADDRESSES, EGRESS_REGION } from "../lib/env";
import { apiError } from "../middleware/error-handler";

/**
 * The published egress feed: the addresses this deployment calls out from,
 * for customers who allowlist inbound traffic by source IP. Unauthenticated,
 * like the rest of `/v1/instance` — it reveals deployment posture, never
 * data, and a firewall team fetching it has no OneCLI session.
 *
 * Shape follows AWS's `ip-ranges.json` (`syncToken`, `createDate`,
 * `prefixes[].ip_prefix`) so existing customer automation parses it, with
 * Snowflake's `effective` / `expires` per entry so the change policy
 * ("additions announced ≥60 days before carrying traffic; removals kept in
 * the feed ≥60 days after") has somewhere to live. Both are `null` for every
 * address today: the list is permanent until a policy event says otherwise.
 *
 * Absent config ⇒ 404 with the standard envelope. This is the self-host
 * posture and a desirable one: a self-hoster's egress is theirs to publish
 * or not. A hosted deployment always sets the list, so there the route is
 * always live.
 *
 * `syncToken` is a hash of the published list, so every replica behind a
 * load balancer answers with the same token for the same list and the token
 * changes exactly when the list does — the property AWS's publication
 * counter gives its consumers. `createDate` is when this response was
 * generated (the feed is computed, not a published file).
 */
const SERVICE = "ONECLI_EGRESS";
const CACHE_CONTROL = "public, max-age=3600";

export type EgressPrefix = {
  ip_prefix: string;
  region: string | null;
  service: typeof SERVICE;
  /** ISO date the address starts carrying traffic; `null` = already does. */
  effective: string | null;
  /** ISO date the address stops carrying traffic; `null` = no plan to. */
  expires: string | null;
};

export type EgressFeed = {
  syncToken: string;
  createDate: string;
  prefixes: EgressPrefix[];
};

/** Stable across replicas: same list ⇒ same token; any change ⇒ new token. */
export const egressSyncToken = (addresses: readonly string[]): string =>
  createHash("sha256").update(addresses.join(",")).digest("hex").slice(0, 16);

export const buildEgressFeed = (
  addresses: readonly string[],
  region: string | null,
  at: Date,
): EgressFeed => ({
  syncToken: egressSyncToken(addresses),
  createDate: at.toISOString(),
  prefixes: addresses.map((address) => ({
    ip_prefix: `${address}/32`,
    region,
    service: SERVICE,
    effective: null,
    expires: null,
  })),
});

export const instanceEgressRoutes = () => {
  const app = new Hono();

  app.get("/", (c) => {
    if (EGRESS_IPV4_ADDRESSES.length === 0) {
      return c.json(
        apiError(
          "This deployment does not publish egress addresses.",
          "not_found_error",
        ),
        404,
      );
    }
    c.header("Cache-Control", CACHE_CONTROL);
    return c.json(
      buildEgressFeed(EGRESS_IPV4_ADDRESSES, EGRESS_REGION, new Date()),
    );
  });

  return app;
};
