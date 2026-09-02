// Registers the jest-dom matchers (toBeInTheDocument, toBeDisabled, …) on
// vitest's expect. Environment-agnostic: safe under the node-env suites too.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL auto-cleans only when a global afterEach exists; this suite keeps
// explicit vitest imports (no `globals: true`), so register it ourselves.
// In the node-env suites nothing is ever mounted and this is a no-op.
afterEach(cleanup);
