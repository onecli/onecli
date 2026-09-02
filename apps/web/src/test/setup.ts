// Registers the jest-dom matchers (toBeInTheDocument, toBeDisabled, …) on
// vitest's expect. Environment-agnostic: safe under the node-env suites too.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL auto-cleans only when a global afterEach exists; this suite keeps
// explicit vitest imports (no `globals: true`), so register it ourselves.
// In the node-env suites nothing is ever mounted and this is a no-op.
afterEach(cleanup);

// jsdom ships no ResizeObserver, and Radix's popper-backed primitives
// (tooltip, popover, select, dropdown) read it on mount - without this a
// component test that renders one dies with a bare ReferenceError deep in
// a layout effect. Node-env suites never touch `globalThis.window`, so the
// guard keeps this a no-op there.
if (typeof globalThis.window !== "undefined" && !globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
