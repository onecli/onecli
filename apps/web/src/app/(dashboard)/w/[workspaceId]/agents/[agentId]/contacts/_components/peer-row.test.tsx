// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPeer } from "@/lib/api";

/**
 * One peer agent's row (PR 5b). Acceptance behaviors: THIS side's policy is
 * the badge, the menu offers the three words and drives the mutation with
 * this peer's id, the OTHER side's word shows only when it is not the
 * default, and "View conversation" is offered exactly when the pair has a
 * conversation.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  forget: vi.fn(),
  resume: vi.fn(),
  isPending: false,
  dialog: vi.fn(),
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetPeerPolicy: () => ({
    mutate: mocks.mutate,
    isPending: mocks.isPending,
  }),
  useForgetPeer: () => ({ mutate: mocks.forget, isPending: false }),
  useResumePeer: () => ({ mutate: mocks.resume, isPending: false }),
}));

vi.mock("./peer-conversation-dialog", () => ({
  PeerConversationDialog: (props: {
    open: boolean;
    conversationId: string;
    agentName: string;
    peerName: string;
  }) => {
    mocks.dialog(props);
    return props.open ? (
      <div data-testid="peer-dialog">
        {props.agentName} and {props.peerName}
      </div>
    ) : null;
  },
}));

import { PeerRow } from "./peer-row";

const peer = (over: Partial<AgentPeer> = {}): AgentPeer => ({
  agentId: "ag-ray",
  name: "Ray",
  workspaceName: null,
  myPolicy: "ask",
  theirPolicy: "ask",
  conversationId: null,
  paused: false,
  taskOpen: false,
  ...over,
});

const renderRow = (p: AgentPeer) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PeerRow agentId="ag-1" agentName="Donna" peer={p} />
    </QueryClientProvider>,
  );

const openPolicyMenu = () =>
  userEvent.click(
    screen.getByRole("button", { name: /Whether Donna and Ray may message/ }),
  );

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.forget.mockReset();
  mocks.resume.mockReset();
  mocks.dialog.mockReset();
  mocks.isPending = false;
});

describe("PeerRow", () => {
  it("shows THIS side's policy as the badge, and nothing for a default other side", () => {
    renderRow(peer());
    expect(screen.getByText("Ray")).toBeDefined();
    expect(screen.getByText("Asks first")).toBeDefined();
    expect(screen.queryByText(/Their side/)).toBeNull();
  });

  it("names the other side's word only when it is not the default", () => {
    renderRow(peer({ theirPolicy: "blocked" }));
    expect(screen.getByText("Their side: blocked")).toBeDefined();
  });

  it("qualifies a peer from another workspace by its workspace", () => {
    renderRow(peer({ workspaceName: "Acme Ops" }));
    expect(screen.getByText("Ray · Acme Ops")).toBeDefined();
  });

  it("the menu offers the three words and mutates with THIS peer's id", async () => {
    renderRow(peer());
    await openPolicyMenu();
    expect(screen.getByText("Allow")).toBeDefined();
    expect(screen.getByText("Ask me first")).toBeDefined();
    expect(screen.getByText("Block")).toBeDefined();
    await userEvent.click(screen.getByText("Allow"));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]![0]).toEqual({
      peerAgentId: "ag-ray",
      policy: "allow",
    });
  });

  it("choosing the current policy is a no-op", async () => {
    renderRow(peer({ myPolicy: "allow" }));
    await openPolicyMenu();
    await userEvent.click(screen.getByText("Allow"));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("says when the other owner is asked too, and when they have blocked", async () => {
    renderRow(peer());
    await openPolicyMenu();
    expect(screen.getByText(/Ray’s side must allow too/)).toBeDefined();
  });

  it("View conversation is disabled until the pair has talked, and opens the dialog once they have", async () => {
    const { unmount } = renderRow(peer());
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    expect(
      screen.getByRole("menuitem", { name: /View conversation/ }),
    ).toHaveProperty("ariaDisabled", "true");
    // Pristine and never talked: nothing to forget, so no Remove yet.
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    unmount();

    renderRow(peer({ conversationId: "cv-pair" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /View conversation/ }),
    );
    expect(screen.getByTestId("peer-dialog").textContent).toBe("Donna and Ray");
    expect(mocks.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, conversationId: "cv-pair" }),
    );
  });

  it("Remove appears once there is something to forget (a policy or a conversation), is last, and is confirm-gated", async () => {
    renderRow(peer({ myPolicy: "allow", conversationId: "cv-pair" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["View conversation", "Remove"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(mocks.forget).not.toHaveBeenCalled();
    expect(screen.getByText(/Clears your side/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.forget).toHaveBeenCalledWith("ag-ray", expect.anything());
  });

  it("Remove also appears when only the OTHER side has decided (their policy is state about this pair too)", async () => {
    renderRow(peer({ theirPolicy: "blocked" }));
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeDefined();
  });

  it("a pair with an open task wears a quiet Working badge; an idle pair does not", () => {
    const { unmount } = renderRow(peer({ taskOpen: true }));
    expect(screen.getByText("Working")).toBeDefined();
    unmount();
    renderRow(peer());
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("a paused pair says so beside the policy, offers Resume first, and resumes THIS peer; an open pair shows neither", async () => {
    renderRow(
      peer({ myPolicy: "allow", conversationId: "cv-pair", paused: true }),
    );
    // Consent and the pause are independent: Allowed stays, Paused joins.
    expect(screen.getByText("Allowed")).toBeDefined();
    expect(screen.getByText("Paused")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Resume", "View conversation", "Remove"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
    expect(mocks.resume).toHaveBeenCalledWith("ag-ray", expect.anything());
    // The dialog is told, so its thread can say why it went quiet.
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /View conversation/ }),
    );
    expect(mocks.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, paused: true }),
    );
  });

  it("an open pair shows no Paused badge and no Resume", async () => {
    renderRow(peer({ myPolicy: "allow", conversationId: "cv-pair" }));
    expect(screen.queryByText("Paused")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More for Ray" }));
    expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull();
  });
});
