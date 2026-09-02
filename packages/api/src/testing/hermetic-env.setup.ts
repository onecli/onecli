/**
 * Vitest setup entry (wired in `vitest.config.ts`): runs in each worker
 * before the test file's module graph evaluates, so the normalization lands
 * before `lib/env.ts` freezes its module-load reads and before any
 * `vi.hoisted` edition pin runs. See `hermetic-env.ts` for the full rationale.
 */
import { normalizeTestEnv } from "./hermetic-env";

normalizeTestEnv(process.env);
