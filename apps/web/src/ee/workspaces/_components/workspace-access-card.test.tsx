// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── The settings-page sharing entry point, through the REAL license gate ────
//
// The bug this pins: on an unlicensed self-host the quota service reports the
// top plan (billing is off), so `isTeam` alone let this card fetch /access and
// open the share dialog — both of which 403 off the API's requireEnterprise
// gate. The card must consult the license gate: locked → no fetch, a license
// message instead of a skeleton, and the guard dialog on click.
//
// PlanGateProvider is real; only its data sources (instance, plan usage) and
// the heavy leaf dialogs are stubbed — deleting the `sharingLocked` wiring in
// the card fails every unlicensed-arm assertion here.

const state = vi.hoisted(() => ({
  instance: null as { edition: string; entitled: boolean } | null,
}));
const accessSpy = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isPending: true, isError: false })),
);

vi.mock("@/ee/billing/use-plan-usage", () => ({ usePlanUsage: () => null }));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => state.instance,
}));
vi.mock("@/hooks/use-workspace-access", () => ({
  useWorkspaceAccess: accessSpy,
}));
vi.mock("@/ee/billing/use-guarded-upgrade", () => ({
  useGuardedUpgrade: () => ({
    startUpgrade: vi.fn(),
    checkoutLoading: false,
    switchTo: null,
    switchInterval: "monthly",
    closeSwitchDialog: vi.fn(),
  }),
}));
vi.mock("@/ee/billing/_components/plan-switch-dialog", () => ({
  PlanSwitchDialog: () => null,
}));
vi.mock("@/lib/components/license-required-dialog", () => ({
  LicenseRequiredDialog: ({
    feature,
    open,
  }: {
    feature: string;
    open: boolean;
  }) => (open ? <div data-testid="license-dialog">{feature}</div> : null),
}));
vi.mock("@/ee/billing/_components/plan-paywall-dialog", () => ({
  PlanPaywallDialog: () => <div data-testid="paywall-dialog" />,
}));
vi.mock("./workspace-access-dialog", () => ({
  WorkspaceAccessDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="access-dialog" /> : null,
}));

import { PlanGateProvider } from "@/lib/plan-gate";
import { WorkspaceAccessCard } from "./workspace-access-card";

const renderCard = (plan: "enterprise" | "free" = "enterprise") =>
  render(
    <PlanGateProvider>
      <WorkspaceAccessCard workspaceId="ws-1" plan={plan} />
    </PlanGateProvider>,
  );

afterEach(() => {
  cleanup();
  accessSpy.mockClear();
});

describe("WorkspaceAccessCard license gating", () => {
  it("unlicensed self-host: suppresses the access fetch, shows the license message, and Manage access opens the license dialog", async () => {
    state.instance = { edition: "onprem", entitled: false };
    renderCard();

    // The guaranteed-403 fetch is disarmed, and no skeleton lingers.
    expect(accessSpy).toHaveBeenCalledWith("ws-1", false);
    expect(
      screen.getByText("Requires a OneCLI Enterprise license"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Manage access" }),
    );
    expect((await screen.findByTestId("license-dialog")).textContent).toBe(
      "workspace_sharing",
    );
    expect(screen.queryByTestId("access-dialog")).toBeNull();
  });

  it("unlicensed self-host with a free-shaped plan: still the license branch, never the cloud upgrade CTA", async () => {
    // Defense in depth: whatever plan shape a caller passes (the settings
    // page once derived "free" from a null subscriptionStatus — the bug this
    // arm pinned), the license branch must outrank the plan branch. A Stripe
    // upgrade CTA is a dead end on an unlicensed self-host.
    state.instance = { edition: "onprem", entitled: false };
    renderCard("free");

    expect(accessSpy).toHaveBeenCalledWith("ws-1", false);
    expect(
      screen.getByText("Requires a OneCLI Enterprise license"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Upgrade to Team")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Manage access" }),
    );
    expect((await screen.findByTestId("license-dialog")).textContent).toBe(
      "workspace_sharing",
    );
  });

  it("licensed: fetches access and Manage access opens the share dialog", async () => {
    state.instance = { edition: "onprem", entitled: true };
    renderCard();

    expect(accessSpy).toHaveBeenCalledWith("ws-1", true);

    await userEvent.click(
      screen.getByRole("button", { name: "Manage access" }),
    );
    expect(await screen.findByTestId("access-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("license-dialog")).toBeNull();
  });
});
