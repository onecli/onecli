import { configDefaults, defineConfig } from "vitest/config";
import {
  API_LANE_ENV,
  laneInvariantPgSuites,
} from "./src/testing/lane-invariant";

/** The `*.pg.test.ts` proof suites (see src/testing/pg-proof.ts). */
const PG_PROOF_SUITES = ["src/**/*.pg.test.ts"];

/**
 * CI's onprem-default lane re-runs this package with the edition unset to
 * prove module-load defaults. pg suites that pin their own edition before
 * anything reads it run identical code in both lanes, so that lane skips
 * them (see src/testing/lane-invariant.ts for the rule and its guard test).
 */
const ONPREM_LANE_SKIPS =
  process.env[API_LANE_ENV] === "onprem"
    ? laneInvariantPgSuites(import.meta.dirname)
    : [];

export default defineConfig({
  test: {
    // Normalizes the ambient shell env to the clean-CI baseline before each
    // test file's module graph loads — see src/testing/hermetic-env.ts.
    setupFiles: ["./src/testing/hermetic-env.setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, ...PG_PROOF_SUITES],
        },
      },
      {
        // The proof suites share ONE PostgreSQL, and some of the code they
        // drive is deliberately fleet-wide (the adapter's presence-ownership
        // pass claims every unowned active presence in the database, the
        // channel-cleanup maintenance pass scans every due job). Two suites
        // in flight at once therefore read each other's fixtures, and which
        // pair overlaps is a matter of scheduling. One fork, one file at a
        // time, is the isolation the schema does not give them; the unit
        // project keeps full parallelism. (`singleFork` is honored per
        // project; the root-level `fileParallelism` is not.)
        extends: true,
        test: {
          name: "pg",
          include: PG_PROOF_SUITES,
          exclude: [...configDefaults.exclude, ...ONPREM_LANE_SKIPS],
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
