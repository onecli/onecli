import pino from "pino";

/**
 * Structured logger for the web app.
 *
 * Production (ECS): JSON to stdout — parsed automatically by CloudWatch Insights.
 * Development: human-readable via pino-pretty.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   const log = logger.child({ component: "auth" });
 *   log.info({ userId }, "session created");
 *   log.error({ err }, "failed to sync user");
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV === "production"
    ? {
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
