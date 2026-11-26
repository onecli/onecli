// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";

/**
 * The agent-proposed custom connection card: the person sees the app's name
 * and the domain the key goes to, types the key into a password field, and
 * can open OneCLI's guide from "Need help?". Approve stays disabled until
 * there is a key and calls the dedicated route, Decline the ordinary decide
 * door.
 */

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  decide: vi.fn(),
  approvePending: false,
}));

vi.mock("@/hooks/use-approvals", () => ({
  useApproveCustomConnection: () => ({
    mutate: state.approve,
    reset: vi.fn(),
    isPending: state.approvePending,
  }),
  useDecideChannelAction: () => ({ mutate: state.decide, isPending: false }),
}));

const { ActionApprovalRow } = await import("./action-approval-row");

const item = (
  over: Partial<
    NonNullable<PendingActionApprovalItem["customConnection"]>
  > = {},
): PendingActionApprovalItem => ({
  kind: "action",
  id: "aa-1",
  agentId: "ag-1",
  agentName: "Donna",
  summary: 'connect "AcmeCRM"',
  standingChoice: false,
  conversationId: "conv-1",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  webhookChange: null,
  customConnection: {
    name: "AcmeCRM",
    hostPattern: "api.acmecrm.io",
    registrableDomain: "acmecrm.io",
    ...over,
  },
});

describe("CustomConnectionApprovalRow", () => {
  beforeEach(() => {
    state.approve.mockReset();
    state.decide.mockReset();
    state.approvePending = false;
  });

  it("is short: the name, where the key goes, the key field", () => {
    render(<ActionApprovalRow item={item()} />);
    expect(screen.getByText("Connect AcmeCRM?")).toBeTruthy();
    // In its own chat the agent is the conversation: no subtitle.
    expect(screen.queryByText(/Donna/)).toBeNull();
  });

  it("names the asking agent in the bell, which lists every agent's asks", () => {
    render(<ActionApprovalRow item={item()} showAgent />);
    expect(screen.getByText("Donna")).toBeTruthy();
    expect(screen.getByText(/asks you for an API key/)).toBeTruthy();
  });

  it("never shows a warning banner", () => {
    render(<ActionApprovalRow item={item()} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Approve disabled until a key is typed, in a password field", async () => {
    render(<ActionApprovalRow item={item()} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText("AcmeCRM API key") as HTMLInputElement;
    expect(input.type).toBe("password");

    await userEvent.type(input, "   ");
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(input);
    await userEvent.type(input, "sk-live-1");
    expect((approve as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Show key" }));
    expect(input.type).toBe("text");
  });

  it("Approve calls the dedicated route with the key; Decline rejects", async () => {
    render(<ActionApprovalRow item={item()} />);
    await userEvent.type(screen.getByLabelText("AcmeCRM API key"), "sk-live-1");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.approve).toHaveBeenCalledWith(
      { approvalId: "aa-1", value: "sk-live-1" },
      expect.anything(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(state.decide).toHaveBeenCalledWith({
      approvalId: "aa-1",
      decision: "reject",
    });
  });

  it("says where the key goes, right above the key input", () => {
    render(<ActionApprovalRow item={item()} />);
    const line = screen.getByTestId("cc-destination");
    expect(line.textContent).toBe("Your key will be sent to acmecrm.io");
    expect(line.querySelector("strong")?.textContent).toBe("acmecrm.io");
    // Directly precedes the input's row.
    const input = screen.getByLabelText("AcmeCRM API key");
    expect(line.nextElementSibling?.contains(input)).toBe(true);
  });

  it("falls back to the host pattern when the registrable domain is unknown", () => {
    render(<ActionApprovalRow item={item({ registrableDomain: null })} />);
    const line = screen.getByTestId("cc-destination");
    expect(line.querySelector("strong")?.textContent).toBe("api.acmecrm.io");
  });

  it("Need help? opens OneCLI's custom connections guide in a new tab, the card's only link", () => {
    render(<ActionApprovalRow item={item()} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    const link = screen.getByRole("link", { name: /Need help\?/ });
    expect(link.getAttribute("href")).toBe(
      "https://onecli.sh/docs/integrations/custom-connections",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toContain("(opens in a new tab)");
  });

  it("shows a loading state while connecting", () => {
    state.approvePending = true;
    render(<ActionApprovalRow item={item()} />);
    const btn = screen.getByRole("button", { name: /Connecting/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
