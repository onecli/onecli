import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Verifies and freezes the template database every test clones.
    globalSetup: ["./src/globalSetup.ts"],
    // Each test spawns a real gateway process (a pool of up to 5 Postgres
    // connections) plus its own Prisma client against its own database. Cap the
    // fleet so the connection budget stays well inside the server's limit — see
    // the connection-budget note in README.md.
    poolOptions: { forks: { maxForks: 4 } },
    // Spawning the binary, cloning a database and waiting on /healthz all cost
    // real time; the approval scenarios additionally hold a socket open.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Diagnostics matter more than brevity here: when a black-box test fails you
    // are looking at captured child-process output, not a stack trace.
    printConsoleTrace: false,
    env: {
      // The one symmetric secret every process in a scenario must share: the
      // fixtures encrypt with it (via @onecli/api's local-AES service, which
      // reads it at module load) and the spawned gateway decrypts with it. A
      // fixed test key, never a production value.
      SECRET_ENCRYPTION_KEY: "3q2+7wEhI0VniavN7xEjRWeJq83vESNFZ4mrze8RI0U=",
    },
  },
});
