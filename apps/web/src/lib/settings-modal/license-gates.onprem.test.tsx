// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// ── The Settings modal's license gates, unlicensed and licensed arms ────────
//
// Security & SSO and Shared apps' availability editor are the only server
// gates in front of their licensed pages (the old route wrappers forward
// here now). Each arm is mutation-detectable: unlicensed, the locked card
// renders and the inner page does NOT; licensed, the inner page renders.

vi.hoisted(() => {
  // Deleted BEFORE the module graph loads: NEXT_PUBLIC_EDITION freezes web
  // CAPS at load, EDITION would silently force isEntitled, and each test
  // owns ENTERPRISE_ENABLED (isEntitled reads env at call time).
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

vi.mock("@/ee/settings/org-sso-page", () => ({
  default: ({ provisioningExtra }: { provisioningExtra?: React.ReactNode }) => (
    <div data-testid="inner-sso">{provisioningExtra}</div>
  ),
}));
vi.mock("@/ee/groups/groups-page", () => ({
  default: () => <div data-testid="inner-groups" />,
}));
vi.mock("@/ee/app-availability/_components/app-availability-editor", () => ({
  AppAvailabilityEditor: () => <div data-testid="inner-app-availability" />,
}));
// The shared tabs own their data; the unit here is the lock under them.
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/chat",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("settings=shared-apps"),
}));
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/apps-tab",
  () => ({ AppsTab: () => null }),
);
vi.mock("@/lib/actions/org-secrets", () => ({
  createOrgSecretAction: vi.fn(),
  deleteOrgSecretAction: vi.fn(),
  updateOrgSecretAction: vi.fn(),
  getOrgSecrets: vi.fn(),
}));

const { isEntitled } = await import("@onecli/api/lib/entitlements");
const { SecurityBody } = await import("./security-body");
const { SharedAppsBody } = await import("./shared-apps-body");

beforeEach(() => vi.stubEnv("ENTERPRISE_ENABLED", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe("Security & SSO", () => {
  it("unlicensed: the locked card, never SSO or Groups", () => {
    render(<SecurityBody />);
    expect(screen.getByText("Enterprise feature")).toBeInTheDocument();
    expect(screen.queryByTestId("inner-sso")).toBeNull();
    expect(screen.queryByTestId("inner-groups")).toBeNull();
  });

  it("licensed: SSO with Groups under it", () => {
    vi.stubEnv("ENTERPRISE_ENABLED", "true");
    render(<SecurityBody />);
    expect(screen.getByTestId("inner-sso")).toContainElement(
      screen.getByTestId("inner-groups"),
    );
    expect(screen.queryByText("Enterprise feature")).toBeNull();
  });
});

describe("Shared apps' availability editor", () => {
  it("unlicensed: the locked card instead of the editor", () => {
    render(<SharedAppsBody entitled={isEntitled()} />);
    expect(screen.getByText("Enterprise feature")).toBeInTheDocument();
    expect(screen.queryByTestId("inner-app-availability")).toBeNull();
  });

  it("licensed: the editor", () => {
    vi.stubEnv("ENTERPRISE_ENABLED", "true");
    render(<SharedAppsBody entitled={isEntitled()} />);
    expect(screen.getByTestId("inner-app-availability")).toBeInTheDocument();
    expect(screen.queryByText("Enterprise feature")).toBeNull();
  });
});
