// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import { DashboardTopBar } from "./dashboard-top-bar";

/**
 * The top bar's right side: the Invite icon sits between the agent's
 * controls and the approvals bell, and only an org admin gets it (the
 * Members page gates its Invite the same way). Upgrade follows the same
 * rule: it opens Billing, an admin page.
 */

const state = vi.hoisted(() => ({
  pathname: "/w/p1/agents/ag-1/chat",
  membership: undefined as { isAdmin: boolean } | undefined,
  usage: undefined as { plan: string } | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-org", () => ({
  useOrgMembership: () => ({ data: state.membership }),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({
    data: [{ id: "ag-1", name: "Donna", kind: "hosted", channels: [] }],
  }),
}));
vi.mock("@/hooks/use-channels", () => ({
  useAgentChannels: () => ({ data: undefined }),
}));
vi.mock("@/ee/billing/use-plan-usage", () => ({
  usePlanUsage: () => state.usage,
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  CAPS: { billing: true },
}));
vi.mock("@/lib/settings-modal/use-settings-href", () => ({
  useSettingsHref: () => (page: string) =>
    `/w/p1/agents/ag-1/chat?settings=${page}`,
}));
vi.mock("@/lib/components/approvals", () => ({
  ApprovalsBell: () => <button data-testid="bell">bell</button>,
}));
vi.mock("./agent-top-bar-controls", () => ({
  AgentTopBarControls: () => <button data-testid="kebab">kebab</button>,
}));
// The real button reads the members quota through a server action; the
// unit here is where it sits and who sees it.
vi.mock("@/lib/team/_components/invite-button", () => ({
  InviteButton: ({ variant }: { variant?: string }) => (
    <button data-testid="invite">{variant}</button>
  ),
}));

const renderBar = (workspaceId: string | undefined) =>
  render(
    <TooltipProvider>
      <DashboardTopBar workspaceId={workspaceId} onOpenMenu={() => {}} />
    </TooltipProvider>,
  );
const renderInWorkspace = () => renderBar("p1");

describe("DashboardTopBar invite icon", () => {
  beforeEach(() => {
    state.pathname = "/w/p1/agents/ag-1/chat";
    state.membership = undefined;
    state.usage = undefined;
  });

  it("sits between the agent's menu and the bell for an admin", () => {
    state.membership = { isAdmin: true };
    renderInWorkspace();
    const invite = screen.getByTestId("invite");
    expect(invite).toHaveTextContent("icon");
    const order = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid"))
      .filter(Boolean);
    expect(order).toEqual(["kebab", "invite", "bell"]);
  });

  it("is absent for a member", () => {
    state.membership = { isAdmin: false };
    renderInWorkspace();
    expect(screen.queryByTestId("invite")).toBeNull();
    expect(screen.getByTestId("bell")).toBeInTheDocument();
  });

  it("is absent until the membership read answers", () => {
    renderInWorkspace();
    expect(screen.queryByTestId("invite")).toBeNull();
  });
});

describe("DashboardTopBar upgrade button", () => {
  beforeEach(() => {
    state.pathname = "/w/p1/agents/ag-1/chat";
    state.membership = undefined;
    state.usage = { plan: "free" };
  });

  it("opens Billing in the Settings modal for an admin on a free plan", () => {
    state.membership = { isAdmin: true };
    renderInWorkspace();
    expect(screen.getByRole("link", { name: "Upgrade" })).toHaveAttribute(
      "href",
      "/w/p1/agents/ag-1/chat?settings=billing",
    );
  });

  // Billing is admin-only in the modal: a member's link would open nothing.
  it("is absent for a member", () => {
    state.membership = { isAdmin: false };
    renderInWorkspace();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
  });

  it("is absent until the membership read answers", () => {
    renderInWorkspace();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
  });

  it("is absent on a sales-managed plan", () => {
    state.membership = { isAdmin: true };
    state.usage = { plan: "enterprise" };
    renderInWorkspace();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
  });
});

// Invite's quota read and Upgrade's plan read resolve the org from the URL's
// scope headers; an `/account/*` URL has none, and the reads used to 500 for
// the instant before its redirect landed.
describe("DashboardTopBar outside an org scope", () => {
  beforeEach(() => {
    state.membership = { isAdmin: true };
    state.usage = { plan: "free" };
  });

  it("draws neither Invite nor Upgrade on an account URL", () => {
    state.pathname = "/account/preferences";
    renderBar(undefined);
    expect(screen.queryByTestId("invite")).toBeNull();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
    expect(screen.getByTestId("bell")).toBeInTheDocument();
  });

  it("draws both on an org URL (no workspace in it)", () => {
    state.pathname = "/org/o1/skills";
    renderBar(undefined);
    expect(screen.getByTestId("invite")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upgrade" })).toBeInTheDocument();
  });
});
