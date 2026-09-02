import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { getAgentImageByKey } from "../services/agent-image-service";

/**
 * The PUBLIC agent-avatar read — deliberately sessionless: Slack fetches a
 * message's `icon_url` with no credentials, so this door cannot demand any.
 * The fence is the path itself: agent id AND the 128-bit random `imageKey`
 * (rotated on every upload) must both match, the presigned-URL model. A miss
 * of either is a hint-free 404.
 *
 * Serving posture mirrors the attachments download: a locked, sniffed
 * Content-Type (raster only — the upload door refuses SVG by magic bytes)
 * plus nosniff, so stored bytes can never execute on this origin.
 */
export const agentImageRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.get("/:agentId/:imageKey", async (c) => {
    const { bytes, mime } = await getAgentImageByKey(
      c.req.param("agentId"),
      c.req.param("imageKey"),
    );
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      // Key rotation means a live URL's content can never silently differ —
      // but it cannot purge caches after a DELETE, so the TTL is what bounds
      // how long a removed avatar keeps serving from shared caches.
      "Cache-Control": "public, max-age=3600",
    });
  });

  return app;
};
