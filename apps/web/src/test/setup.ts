import { afterEach } from "vitest";

// Everything below is DOM-only. The node-env suites (the default environment)
// never mount anything, and importing jest-dom + RTL there costs far more
// than their tests do, so load them only when a DOM exists. A node-env file
// that reaches for a jest-dom matcher fails loudly ("invalid chai property")
// instead: give it the `// @vitest-environment jsdom` docblock.
if (typeof globalThis.window !== "undefined") {
  // Registers the jest-dom matchers (toBeInTheDocument, toBeDisabled, …) on
  // vitest's expect.
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");

  // RTL auto-cleans only when a global afterEach exists; this suite keeps
  // explicit vitest imports (no `globals: true`), so register it ourselves.
  afterEach(cleanup);

  // jsdom ships no ResizeObserver, and Radix's popper-backed primitives
  // (tooltip, popover, select, dropdown) read it on mount - without this a
  // component test that renders one dies with a bare ReferenceError deep in
  // a layout effect.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}
