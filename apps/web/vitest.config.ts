import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors tsconfig `paths` — vite doesn't read those on its own.
      "@dashboard": path.resolve(
        import.meta.dirname,
        "src/app/(dashboard)/_components",
      ),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // The default environment stays `node` — the pure-logic suites depend on
    // it. Component tests opt into the DOM per file with a
    // `// @vitest-environment jsdom` docblock.
    setupFiles: ["src/test/setup.ts"],
  },
});
