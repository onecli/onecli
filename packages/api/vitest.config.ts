import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Normalizes the ambient shell env to the clean-CI baseline before each
    // test file's module graph loads — see src/testing/hermetic-env.ts.
    setupFiles: ["./src/testing/hermetic-env.setup.ts"],
  },
});
