import { Server } from "node:http";
import { serve } from "@hono/node-server";
import {
  formatOriginsBanner,
  resolveOriginsFromEnv,
} from "@onecli/api/lib/public-origins";
import { createServerApp, type ServerExtensions } from "./app";
import { logger } from "./logger";
import { startAwsMarketplaceMeteringJob } from "@onecli/api/ee/billing/aws-marketplace/metering-job";
import { startInboundEventRecovery } from "@onecli/api/services/channels/inbound-event-service";

/**
 * Boot the api-server: the shared entry (`index.ts`) calls this with no
 * extensions; a deployment's own entry may pass its `ServerExtensions`.
 */
export const serveApiServer = (extensions: ServerExtensions = {}): void => {
  const app = createServerApp(extensions);
  const port = Number(process.env.PORT || 10256);

  // The one boot-time report of every address this deployment advertises,
  // each value tagged with where it came from. A misconfigured
  // ONECLI_EXTERNAL_URL throws here — at boot, with the fix in the message —
  // rather than surfacing as broken links at request time.
  const origins = resolveOriginsFromEnv();
  for (const line of formatOriginsBanner(origins)) logger.info(line);
  for (const warning of origins.warnings) logger.warn(warning);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    // The BOUND port, not the requested one: with PORT=0 the OS picks it, and
    // a caller (the hosted E2E harness) reads it from this line.
    logger.info(
      { port: info.port },
      `api-server listening on port ${String(info.port)}`,
    );
  });

  // AWS Marketplace overage metering (no-op unless the listing is configured).
  startAwsMarketplaceMeteringJob();

  // Channel events accepted over HTTP are processed right after their ack; this
  // pass finishes any a crashed or restarted replica left half-done.
  startInboundEventRecovery();

  // Must exceed a fronting load balancer's idle timeout (commonly 60–65s) or it
  // reuses connections Node has already closed → sporadic 502s.
  if (server instanceof Server) {
    server.keepAliveTimeout = 70000;
    server.headersTimeout = 71000;
  }
};
