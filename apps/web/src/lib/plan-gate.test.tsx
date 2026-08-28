// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ENTERPRISE_FEATURES } from "@onecli/api/lib/entitlements";

// ── THE client license gate ─────────────────────────────────────────────────
//
// plan-gate is the single choke point every EE interaction leans on
// (manage-access, workspace sharing, identity pickers, resource scoping).
// Three contracts, each mutation-detectable:
//   1. entitled:false locks EXACTLY the ENTERPRISE_FEATURES keys, and guard()
//      opens the license dialog (delete `!instance.entitled` → arm 1 fails);
//   2. instance null (in flight) locks NOTHING — the documented
//      never-falsely-gate contract (invert the null check → arm 2 fails);
//   3. entitled:true locks nothing on self-host.
// The plan lock is disarmed here (usePlanUsage → null, the self-host state);
// its cloud behavior belongs to the billing suites.

const state = vi.hoisted(() => ({
  instance: null as {
    edition: string;
    entitled: boolean;
    version: string;
  } | null,
}));

vi.mock("@/ee/billing/use-plan-usage", () => ({
  usePlanUsage: () => null,
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => state.instance,
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

import { PlanGateProvider, usePlanGate } from "./plan-gate";

const FEATURES = Object.keys(ENTERPRISE_FEATURES);

const Probe = () => {
  const gate = usePlanGate();
  return (
    <div>
      {FEATURES.map((f) => (
        <span key={f} data-testid={`lock-${f}`}>
          {String(gate.isLocked(f))}
        </span>
      ))}
      <span data-testid="lock-nonfeature">
        {String(gate.isLocked("agents"))}
      </span>
      <button data-testid="guard" onClick={() => gate.guard("groups")}>
        guard
      </button>
    </div>
  );
};

const renderGate = () =>
  render(
    <PlanGateProvider>
      <Probe />
    </PlanGateProvider>,
  );

describe("plan-gate license lock", () => {
  it("entitled:false locks exactly the enterprise feature keys, and guard opens the license dialog", async () => {
    state.instance = { edition: "onprem", entitled: false, version: "t" };
    renderGate();
    for (const f of FEATURES) {
      expect(screen.getByTestId(`lock-${f}`).textContent, f).toBe("true");
    }
    expect(screen.getByTestId("lock-nonfeature").textContent).toBe("false");

    screen.getByTestId("guard").click();
    expect((await screen.findByTestId("license-dialog")).textContent).toBe(
      "groups",
    );
    cleanup();
  });

  it("instance still loading (null) locks NOTHING — never falsely gate", () => {
    state.instance = null;
    renderGate();
    for (const f of FEATURES) {
      expect(screen.getByTestId(`lock-${f}`).textContent, f).toBe("false");
    }
    screen.getByTestId("guard").click();
    expect(screen.queryByTestId("license-dialog")).toBeNull();
    cleanup();
  });

  it("entitled:true locks nothing", () => {
    state.instance = { edition: "onprem", entitled: true, version: "t" };
    renderGate();
    for (const f of FEATURES) {
      expect(screen.getByTestId(`lock-${f}`).textContent, f).toBe("false");
    }
    screen.getByTestId("guard").click();
    expect(screen.queryByTestId("license-dialog")).toBeNull();
    cleanup();
  });
});
