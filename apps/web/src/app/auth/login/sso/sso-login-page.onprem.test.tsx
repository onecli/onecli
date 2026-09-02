// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── /auth/login/sso, unlicensed arm ─────────────────────────────────────────
//
// Before the wrapper, an unlicensed self-host rendered the full SSO form
// whose lookup could only 403 (surfacing as a misleading outage message).
// Now: unlicensed → redirect to the regular login; licensed → the form.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

// Throwing redirect mock — a fall-through mock hides bugs (house pattern).
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/ee/auth/sso-login-content", () => ({
  SsoLoginContent: () => <div data-testid="sso-form" />,
}));

import Page from "./page";

beforeEach(() => vi.stubEnv("ENTERPRISE_ENABLED", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe("/auth/login/sso wrapper", () => {
  it("unlicensed: redirects to the regular login — no dead-end SSO form", () => {
    expect(() => Page()).toThrow("NEXT_REDIRECT:/auth/login");
  });

  it("licensed: renders the SSO form", () => {
    vi.stubEnv("ENTERPRISE_ENABLED", "true");
    render(Page());
    expect(screen.getByTestId("sso-form")).toBeInTheDocument();
  });
});
