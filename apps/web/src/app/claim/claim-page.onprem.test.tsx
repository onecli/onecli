// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── /claim, unlicensed arm ──────────────────────────────────────────────────
//
// The dark-reads pin for the web bypass: enterprise-lock covers the /v1
// provisioning routes, but this page reaches findPendingProvisionByToken
// through a server component — before the wrapper existed, an unlicensed
// self-host resolved any claim token and rendered the live org name.
// Mutation-detectable both ways: unlicensed → locked card AND zero service
// reads; licensed → the real page runs and reads the token.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

const state = vi.hoisted(() => ({ tokenReads: 0 }));

// The inner page is REAL — only its data edges are stubbed, so the licensed
// arm proves the wrapper actually lets the flow run (and count reads).
vi.mock("@onecli/api/ee/services/user-provision-service", () => ({
  findPendingProvisionByToken: async () => {
    state.tokenReads += 1;
    return { organizationName: "Acme" };
  },
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => null,
}));
vi.mock("@/ee/team/_components/claim-sign-in", () => ({
  ClaimSignIn: () => <div data-testid="claim-sign-in" />,
}));
vi.mock("@/ee/team/_components/claim-form", () => ({
  ClaimForm: () => <div data-testid="claim-form" />,
}));

import Page from "./page";

const props = { searchParams: Promise.resolve({ token: "tok-1" }) };

beforeEach(() => {
  state.tokenReads = 0;
  vi.stubEnv("ENTERPRISE_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe("/claim wrapper (provisioning dark reads)", () => {
  it("unlicensed: locked card, token NEVER resolved, org name never fetched", async () => {
    render(await Page(props));
    expect(screen.getByText("Enterprise")).toBeInTheDocument();
    expect(state.tokenReads).toBe(0);
    expect(screen.queryByTestId("claim-sign-in")).toBeNull();
  });

  it("licensed: the claim flow runs and resolves the token", async () => {
    vi.stubEnv("ENTERPRISE_ENABLED", "true");
    render(await Page(props));
    expect(state.tokenReads).toBe(1);
    expect(screen.getByTestId("claim-sign-in")).toBeInTheDocument();
    expect(screen.queryByText("Enterprise")).toBeNull();
  });
});
