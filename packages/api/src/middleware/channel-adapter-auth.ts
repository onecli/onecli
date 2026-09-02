import { createMiddleware } from "hono/factory";
import { db } from "@onecli/db";
import { logger } from "../lib/logger";

const log = logger.child({ component: "channel-adapter-auth" });

/**
 * Bearer auth for the `cha_` token family — the channel adapter's credential
 * (step 6), modeled on `runner-auth.ts` clause for clause: its own narrow
 * middleware, a `cha_` token authorizes `/v1/channel-adapter/*` and NOTHING
 * else, and no other family passes here (an `oc_` key, an `rnr_` token, or a
 * session hits the same hint-free 401). Widening either direction is a
 * security regression, and both directions are tested.
 *
 * Liveness rides every call — the adapter's poll loop is its own heartbeat.
 */

export interface ChannelAdapterAuthContext {
  adapterId: string;
  name: string;
  /** "anchor" (legacy shared identity) | "instance" (per-instance mint) —
   * drives the config feed's etag recipe. */
  kind: string;
}

export type ChannelAdapterEnv = {
  Variables: { channelAdapter: ChannelAdapterAuthContext };
};

const unauthorized = { error: "Unauthorized" } as const;

export const channelAdapterAuth = createMiddleware<ChannelAdapterEnv>(
  async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token || !token.startsWith("cha_")) {
      return c.json(unauthorized, 401);
    }

    const adapter = await db.channelAdapter.findUnique({
      where: { token },
      select: { id: true, name: true, kind: true },
    });
    if (!adapter) return c.json(unauthorized, 401);

    c.set("channelAdapter", {
      adapterId: adapter.id,
      name: adapter.name,
      kind: adapter.kind,
    });

    db.channelAdapter
      .update({ where: { id: adapter.id }, data: { lastSeenAt: new Date() } })
      .catch((err: unknown) => {
        log.warn(
          { err, adapterId: adapter.id },
          "adapter lastSeenAt touch failed",
        );
      });

    await next();
  },
);
