import { NEXT_RUNTIME, NODE_ENV, LOG_LEVEL } from "@/lib/env";

/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * In production, patches console.* to route all output through pino
 * as structured JSON. This captures both our code AND Next.js internal
 * logs (startup, errors, request logging) in a format CloudWatch
 * Insights can parse.
 *
 * In development, console.* is left untouched (pino-pretty handles
 * our explicit logger calls, and Next.js dev output stays readable).
 */
export async function register() {
  if (NEXT_RUNTIME === "nodejs" && NODE_ENV === "production") {
    const pino = (await import("pino")).default;
    const logger = pino({
      level: LOG_LEVEL,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    });

    console.log = (...args: unknown[]) =>
      logger.info(args.length === 1 ? args[0] : { msg: args.join(" ") });
    console.info = (...args: unknown[]) =>
      logger.info(args.length === 1 ? args[0] : { msg: args.join(" ") });
    console.warn = (...args: unknown[]) =>
      logger.warn(args.length === 1 ? args[0] : { msg: args.join(" ") });
    console.error = (...args: unknown[]) =>
      logger.error(args.length === 1 ? args[0] : { msg: args.join(" ") });
  }
}
