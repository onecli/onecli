import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `hasProjectContext` reads `CAPS` from `@/lib/env`, which is resolved from
 * `NEXT_PUBLIC_EDITION` at module evaluation — so each case stubs the env and
 * re-imports the module fresh.
 */
const loadHasProjectContext = async (edition: string) => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_EDITION", edition);
  const { hasProjectContext } = await import("./navigation");
  return hasProjectContext;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasProjectContext", () => {
  it("oss: every dashboard path has the implicit project context", async () => {
    const hasProjectContext = await loadHasProjectContext("");
    expect(hasProjectContext("/")).toBe(true);
    expect(hasProjectContext("/agents")).toBe(true);
    expect(hasProjectContext("/activity")).toBe(true);
  });

  it("cloud: only /p/<id> paths carry a project context", async () => {
    const hasProjectContext = await loadHasProjectContext("cloud");
    expect(hasProjectContext("/p/abc")).toBe(true);
    expect(hasProjectContext("/p/abc/agents")).toBe(true);
    expect(hasProjectContext("/")).toBe(false);
    expect(hasProjectContext("/agents")).toBe(false);
    expect(hasProjectContext("/org/o1/global-connections")).toBe(false);
  });

  // Deliberate: onprem-full keeps the pre-bell project-page scoping even
  // though its gateway also resolves the project server-side (it runs the
  // OSS gateway-auth — no X-Project-Id header). Widening it is a separate
  // product decision, not a side effect of the OSS fix.
  it("onprem-full: URL-scoped like cloud", async () => {
    const hasProjectContext = await loadHasProjectContext("onprem-full");
    expect(hasProjectContext("/p/abc")).toBe(true);
    expect(hasProjectContext("/agents")).toBe(false);
  });

  it("onprem-slim: single implicit project like oss", async () => {
    const hasProjectContext = await loadHasProjectContext("onprem-slim");
    expect(hasProjectContext("/agents")).toBe(true);
  });
});
