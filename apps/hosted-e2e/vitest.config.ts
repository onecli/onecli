import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Verifies the template database, sweeps stale runs (databases AND
    // docker leftovers), and asserts the agent image exists.
    globalSetup: ["./src/globalSetup.ts"],
    exclude: ["**/node_modules/**"],
    // Each test stands up an api-server child, a gateway child, an in-process
    // runner, and real sandbox containers on one Docker daemon. Two forks keep
    // container churn (create/start/stop, image reads, port allocations)
    // inside what a laptop and a CI runner absorb without flaking.
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    printConsoleTrace: false,
    env: {
      // The one symmetric secret every process in a scenario must share: the
      // fixtures encrypt with it (via @onecli/api's local-AES service, which
      // reads it at module load) and the spawned api-server + gateway decrypt
      // with it. A fixed test key, never a production value.
      SECRET_ENCRYPTION_KEY: "3q2+7wEhI0VniavN7xEjRWeJq83vESNFZ4mrze8RI0U=",
    },
  },
});
