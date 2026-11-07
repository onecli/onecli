/**
 * Vitest setup entry (wired in `vitest.config.ts`): runs before EVERY test
 * file's module graph evaluates, so the normalization (and, for a later file
 * in the same worker, the reset to the worker baseline) lands before
 * `lib/env.ts` freezes its module-load reads and before any `vi.hoisted`
 * edition pin runs. See `hermetic-env.ts` for the full rationale.
 */
import { applyHermeticEnv, workerBaselineHolder } from "./hermetic-env";

applyHermeticEnv(process.env, workerBaselineHolder());
