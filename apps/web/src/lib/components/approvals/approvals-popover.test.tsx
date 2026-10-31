// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";
import type { LostChannelConnectionItem } from "@/lib/api/channel-alerts";
import { ApprovalsPopover } from "./approvals-popover";

/**
 * The ONE inbox (4d): gateway prompts, action approvals, and reach asks in
 * one age-sorted list — each kind rendering its own decide surface.
 */

const mocks = vi.hoisted(() => ({
  gateway: [] as PendingApproval[],
  channel: [] as PendingChannelApprovalItem[],
  alerts: [] as LostChannelConnectionItem[],
  dismiss: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/agents" }));
vi.mock("@/hooks/use-channel-alerts", () => ({
  useChannelAlerts: () => ({ data: mocks.alerts }),
  dismissChannelAlert: mocks.dismiss,
}));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingApprovals: () => ({ data: mocks.gateway }),
  usePendingChannelApprovals: () => ({ data: mocks.channel }),
  useDecideApproval: () => ({ mutate: vi.fn(), isPending: false }),
  useDecideChannelAction: () => ({ mutate: vi.fn(), isPending: false }),
  useApproveCustomConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useDecideChannelReach: () => ({ mutate: vi.fn(), isPending: false }),
}));

const gatewayApproval = (id: string, createdAt: string): PendingApproval => ({
  id,
  method: "POST",
  url: "https://api.example.com/send",
  host: "api.example.com",
  path: "/send",
  headers: {},
  agent: { id: "ag-1", name: "Donna" },
  createdAt,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
});

const renderPopover = () => {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsPopover onShowDetails={() => {}} />
    </QueryClientProvider>,
  );
};

describe("ApprovalsPopover (4d, the one inbox)", () => {
  it("shows the empty state when nothing pends anywhere", () => {
    mocks.gateway = [];
    mocks.channel = [];
    mocks.alerts = [];
    renderPopover();
    expect(screen.getByText("No pending approvals")).toBeDefined();
    expect(screen.getByText("You're all caught up.")).toBeDefined();
  });

  it("a lost connection leads the inbox, and the empty state stops saying all caught up", () => {
    mocks.gateway = [];
    mocks.channel = [];
    mocks.alerts = [
      {
        id: "pres-1",
        agentId: "ag-1",
        agentName: "Donna",
        provider: "slack",
        lostAt: "2026-09-07T10:00:00Z",
      },
    ];
    try {
      renderPopover();
      expect(screen.getByText("Needs attention")).toBeDefined();
      expect(screen.getByText("Donna lost its Slack connection")).toBeDefined();
      // The registry's mark (the positive control for the unknown-provider
      // case below, which must render none).
      expect(screen.getByRole("img", { name: "Slack" })).toBeDefined();
      const fix = screen.getByRole("link", { name: "Fix in Slack" });
      expect(fix.getAttribute("href")).toBe("/w/ws-1/agents/ag-1/channels");
      expect(screen.queryByText("You're all caught up.")).toBeNull();

      fireEvent.click(fix);
      expect(mocks.dismiss).toHaveBeenCalledWith(mocks.alerts[0]);
    } finally {
      mocks.alerts = [];
    }
  });

  it("a provider this web doesn't know yet reads generically, without an icon", () => {
    mocks.gateway = [];
    mocks.channel = [];
    mocks.alerts = [
      {
        id: "pres-2",
        agentId: "ag-2",
        agentName: "Harvey",
        provider: "teams",
        lostAt: "2026-09-07T10:00:00Z",
      },
    ];
    try {
      renderPopover();
      expect(
        screen.getByText("Harvey lost its chat app connection"),
      ).toBeDefined();
      expect(
        screen.getByRole("link", { name: "Fix in chat app" }),
      ).toBeDefined();
      expect(screen.queryByRole("img")).toBeNull();
    } finally {
      mocks.alerts = [];
    }
  });

  it("merges all three kinds oldest-first", () => {
    mocks.gateway = [gatewayApproval("gw-1", "2026-09-07T10:02:00Z")];
    mocks.channel = [
      {
        kind: "action",
        id: "act-1",
        agentId: "ag-1",
        agentName: "Donna",
        summary: 'send @Tomer: "hello"',
        standingChoice: false,
        conversationId: null,
        createdAt: "2026-09-07T10:01:00Z",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        webhookChange: null,
        customConnection: null,
      },
      {
        kind: "reach",
        id: "reach-1",
        agentId: "ag-1",
        agentName: "Donna",
        provider: "slack",
        subjectKind: "space",
        subjectLabel: "#general",
        externalRef: "C1",
        createdAt: "2026-09-07T10:00:00Z",
      },
    ];
    renderPopover();

    // All three kinds render their decide surfaces.
    expect(screen.getByText('send @Tomer: "hello"')).toBeDefined();
    expect(screen.getByText("Donna was added to #general")).toBeDefined();
    expect(screen.getByRole("button", { name: "Everyone" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Nobody" })).toBeDefined();
    // "OneCLI users only" was retired: a channel is everyone, or nobody.
    expect(screen.queryByRole("button", { name: "Teammates only" })).toBeNull();

    // Oldest first: reach (10:00) before action (10:01) before gateway (10:02).
    const text = document.body.textContent ?? "";
    expect(text.indexOf("#general")).toBeLessThan(text.indexOf("@Tomer"));
  });

  it("a person reach ask offers the app-permission words: Always allow, Never", () => {
    mocks.gateway = [];
    mocks.channel = [
      {
        kind: "reach",
        id: "reach-2",
        agentId: "ag-1",
        agentName: "Donna",
        provider: "slack",
        subjectKind: "external_user",
        subjectLabel: "Moshe",
        externalRef: "U9",
        createdAt: "2026-09-07T10:00:00Z",
      },
    ];
    renderPopover();
    expect(screen.getByText("Moshe wants to talk to Donna")).toBeDefined();
    for (const name of ["Always allow", "Never"]) {
      expect(screen.getByRole("button", { name })).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "Needs approval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Teammates only" })).toBeNull();
  });
});
