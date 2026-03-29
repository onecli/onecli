import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import turboPlugin from "eslint-plugin-turbo";
import onlyWarn from "eslint-plugin-only-warn";
import globals from "globals";

/**
 * ESLint configuration for the Next.js app.
 *
 * Uses the official eslint-config-next which includes:
 * - @next/eslint-plugin-next (Next.js rules + core web vitals)
 * - eslint-plugin-react (React rules)
 * - eslint-plugin-react-hooks v7 (hooks + React Compiler rules)
 * - eslint-plugin-jsx-a11y (accessibility)
 * - eslint-plugin-import (import validation)
 * - typescript-eslint (TypeScript rules)
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const nextJsConfig = defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  eslintConfigPrettier,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    plugins: {
      turbo: turboPlugin,
      onlyWarn,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
      // Disabled until pages are migrated to server components.
      // The rule flags async fetch→setState in effects, which is the standard
      // client-side data fetching pattern and works correctly.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["**/*.config.{js,ts,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
