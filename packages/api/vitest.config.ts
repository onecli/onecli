import { configDefaults, defineConfig } from "vitest/config";

/** The `*.pg.test.ts` proof suites (see src/testing/pg-proof.ts). */
const PG_PROOF_SUITES = ["src/**/*.pg.test.ts"];

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
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
