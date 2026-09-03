import { Server } from "node:http";
import { serve } from "@hono/node-server";
import {
  formatOriginsBanner,
  resolveOriginsFromEnv,
} from "@onecli/api/lib/public-origins";
import { app } from "./app";
import { logger } from "./logger";
import { startAwsMarketplaceMeteringJob } from "@onecli/api/ee/billing/aws-marketplace/metering-job";

const port = Number(process.env.PORT || 10256);

// The one boot-time report of every address this deployment advertises,
// each value tagged with where it came from. A misconfigured
// ONECLI_EXTERNAL_URL throws here — at boot, with the fix in the message —
// rather than surfacing as broken links at request time.
const origins = resolveOriginsFromEnv();
for (const line of formatOriginsBanner(origins)) logger.info(line);
for (const warning of origins.warnings) logger.warn(warning);

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "api-server listening");
});

// AWS Marketplace overage metering (no-op unless the listing is configured).
startAwsMarketplaceMeteringJob();

// Must exceed the ALB idle timeout (65s) or the ALB reuses connections
// Node has already closed → sporadic 502s.
if (server instanceof Server) {
  server.keepAliveTimeout = 70000;
  server.headersTimeout = 71000;
}
