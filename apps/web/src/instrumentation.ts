import { NODE_ENV, LOG_LEVEL, CAPS } from "@/lib/env";

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

    // Onprem: eagerly provision the org + operator API key at boot so the
    // instance is usable via the org key immediately — before anyone opens the
    // web (headless). Runs for any onprem auth mode; the key is owned by the
    // bootstrap admin user. Idempotent; never fatal (a failure just falls back to
    // the lazy first-login bootstrap).
    if (CAPS.tenancy === "single-org-shared") {
      try {
        const { ensureOnpremInstance } =
          await import("@/lib/auth/ensure-onprem-instance");
        await ensureOnpremInstance();
      } catch (err) {
        console.error(
          "onprem eager bootstrap failed; will retry lazily on first login",
          err,
        );
      }
    }

    // Boot policy passes (after the entrypoint's `prisma migrate deploy`),
    // sequenced migrate → adopt → compact in the background, best-effort — a
    // failure logs loudly but never crashes the web. WHICH pass does work is decided
    // INSIDE the aliased impls (step 9.5), each self-gated on the editing flag,
    // so every edition keeps its exact pre-9.5 behavior:
    //
    // - EE editions (via resolveAlias): editing OFF → the real backfill
    //   (`@/ee/policy-migrate` — prepares v2; the enforce flip is gated on its
    //   "verify clean" log); editing ON → the adoption pass
    //   (`@/ee/policy-adopt` — re-tags app_permission rules as custom,
    //   idempotent, self-healing across deploy windows).
    // - OSS: `@/lib/policy-migrate` is the release-as-cutover pass (translate
    //   the legacy project state → one atomic published generation per project
    //   → verify; the published generation is the gateway's per-project
    //   enable signal), self-gated so the flag-off rollback posture is pure
    //   legacy. OSS adoption is folded into its translation (`@/lib/policy-adopt`
    //   stays a no-op).
    //
    // Concurrent replicas + reboots stay safe (per-scope advisory lock +
    // published-generation idempotency in every pass).
    void import("@/lib/policy-migrate")
      .then(({ runPolicyMigration }) => runPolicyMigration())
      .catch((err) => console.error("[policy-migrate] failed:", err))
      .then(() => import("@/lib/policy-adopt"))
      .then(({ runPolicyAdoption }) => runPolicyAdoption())
      .catch((err) => console.error("[policy-adopt] failed:", err))
      // Compaction MUST follow adoption — it keys on the draft↔published
      // logicalId parity the adoption pass establishes (EE editions; the OSS
      // impl stays a no-op — its cutover groups at translation time).
      .then(() => import("@/lib/policy-compact"))
      .then(({ runPolicyCompaction }) => runPolicyCompaction())
      .catch((err) => console.error("[policy-compact] failed:", err));
  }
}
