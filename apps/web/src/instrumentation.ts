import { NODE_ENV, LOG_LEVEL } from "@/lib/env";

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
  // NEXT_RUNTIME is read literally (not via @/lib/env) so Next.js can inline it
  // per-runtime and the Edge compile drops this whole Node-only branch — via the
  // env re-export the branch survives DCE and the dynamic imports below get
  // traced into node:crypto/node:fs, warning on every Edge build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fill the provider seams (role resolver, team hooks, policy seeder, …)
    // as a property of the PROCESS, before any request renders. Relying on
    // `@/lib/init/server` alone (sole importer: lib/actions/resolve-user.ts)
    // left renders whose module graph never touched that file with EMPTY
    // seams — on an entitled self-host the role-resolver slot read as null
    // and `canAccessWorkspaceAsUser` silently denied the workspace's own
    // owner, bouncing the browser to /org on a fresh install's first open.
    const { ensureEditionDefaults } = await import("@onecli/api");
    ensureEditionDefaults();

    // One boot-time report of the advertised addresses this process will
    // inject into every page, each tagged with where it came from. A
    // misconfigured ONECLI_EXTERNAL_URL throws here — at startup, with the
    // fix in the message — instead of 500ing every render.
    const { formatOriginsBanner, resolveOriginsFromEnv } =
      await import("@onecli/api/lib/public-origins");
    const origins = resolveOriginsFromEnv();
    for (const line of formatOriginsBanner(origins)) console.info(line);
    for (const warning of origins.warnings) console.warn(warning);
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && NODE_ENV === "production") {
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
