/**
 * Vitest setup entry for the pg project only (wired in `vitest.config.ts`):
 * the same per-file reset every suite gets, then the proof database pinned
 * back into `DATABASE_URL` in the SAME synchronous step, so there is never a
 * moment between files where a stray query finds no URL. See
 * `hermetic-env.ts` (module doc, step 6).
 */
import {
  applyHermeticEnv,
  pinProofDatabaseUrl,
  workerBaselineHolder,
} from "./hermetic-env";

applyHermeticEnv(process.env, workerBaselineHolder());
pinProofDatabaseUrl(process.env);
