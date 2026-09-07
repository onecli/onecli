// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";
import { ApprovalsPopover } from "./approvals-popover";

/**
 * The ONE inbox (4d): gateway prompts, action approvals, and reach asks in
 * one age-sorted list — each kind rendering its own decide surface.
 */

const mocks = vi.hoisted(() => ({
  gateway: [] as PendingApproval[],
  channel: [] as PendingChannelApprovalItem[],
}));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingApprovals: () => ({ data: mocks.gateway }),
  usePendingChannelApprovals: () => ({ data: mocks.channel }),
  useDecideApproval: () => ({ mutate: vi.fn(), isPending: false }),
  useDecideChannelAction: () => ({ mutate: vi.fn(), isPending: false }),
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
    renderPopover();
    expect(screen.getByText("No pending approvals")).toBeDefined();
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
        createdAt: "2026-09-07T10:01:00Z",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
    expect(
      screen.getByRole("button", { name: "Teammates only" }),
    ).toBeDefined();

    // Oldest first: reach (10:00) before action (10:01) before gateway (10:02).
    const text = document.body.textContent ?? "";
    expect(text.indexOf("#general")).toBeLessThan(text.indexOf("@Tomer"));
  });

  it("a person reach ask offers exactly two settlements", () => {
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
    expect(screen.getByRole("button", { name: "Allow" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Block" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Teammates only" })).toBeNull();
  });
});
