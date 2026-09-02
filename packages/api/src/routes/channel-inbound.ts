import { Hono } from "hono";
import type { ApiEnv } from "../types";
import type { ChannelProviderId } from "../services/channels/types";
import { channelInboundSlackRoutes } from "./channel-inbound-slack";

/**
 * The provider-neutral mount for inbound channel webhooks (§3.16): each
 * provider's HTTP arm — events, interactivity, OAuth callbacks — is
 * intrinsically provider-shaped (signature scheme, retry headers, challenge
 * echoes), so the route FILES stay provider-scoped; what must not be
 * provider-shaped is the composition root. `app.ts` mounts this one router,
 * and a provider's routes land under `/channels/<providerId>` — the prefix
 * derives from the registry key, so a consent redirect URI built from the
 * provider id can never drift from the mounted path.
 *
 * `Record` keyed by the id union, deliberately (the registry pattern):
 * adding a provider without deciding its inbound arm is a compile error.
 * `null` = the provider has no inbound HTTP surface.
 */
const CHANNEL_INBOUND_ROUTES: Record<
  ChannelProviderId,
  (() => Hono<ApiEnv>) | null
> = {
  slack: channelInboundSlackRoutes,
};

export const channelInboundRoutes = (): Hono<ApiEnv> => {
  const app = new Hono<ApiEnv>();
  for (const [providerId, routes] of Object.entries(CHANNEL_INBOUND_ROUTES)) {
    if (routes) app.route(`/${providerId}`, routes());
  }
  return app;
};
