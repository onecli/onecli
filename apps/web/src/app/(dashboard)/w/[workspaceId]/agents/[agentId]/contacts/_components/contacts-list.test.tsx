// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChannelsView, AgentPeer } from "@/lib/api";
import type { ActAsYouSlot } from "./act-as-you-slot";

/**
 * The Contacts section composes rows from two queries into three kind
 * groups (Direct messages, Channels, Agents). Acceptance behaviors: every
 * row lands in the group of its kind, reach rows come only from LIVE
 * presences, there is no Apps group, an empty group says so, and loading
 * is a skeleton.
 */

const state = vi.hoisted(() => ({
  view: undefined as AgentChannelsView | undefined,
  peers: [] as AgentPeer[],
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "Donna", kind: "hosted" }),
}));

vi.mock("@/hooks/use-channels", () => ({
  useAgentChannels: () => ({
    data: state.view,
    isPending: state.view === undefined,
    isError: false,
    refetch: vi.fn(),
  }),
  useAgentPeers: () => ({
    data: { peers: state.peers },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

// The rows are each their own tested component; here they are stubs that
// say which group they landed in.
vi.mock("./contact-row", () => ({
  ContactRow: ({
    entry,
    extras,
  }: {
    entry: { key: string };
    extras?: { cells: { reads: React.ReactNode } } | null;
  }) => (
    <div data-testid="contact">
      {entry.key}
      {extras?.cells.reads}
    </div>
  ),
}));
vi.mock("./peer-row", () => ({
  PeerRow: ({ peer }: { peer: AgentPeer }) => (
    <div data-testid="peer">{peer.name}</div>
  ),
}));

import { ContactsList as ContactsSection } from "./contacts-list";

const presence = (
  status: "active" | "disabled",
): AgentChannelsView["presences"][number] =>
  ({
    id: `p-${status}`,
    provider: "slack",
    status,
    transport: "socket",
    externalId: "A1",
    identityRef: "B1",
    identityName: "donna",
    tenant: { externalId: "T1", name: "Acme" },
    managedBy: null,
    groupThreads: [],
    spaces: [
      {
        externalRef: `C-${status}`,
        label: "#room",
        state: "approved",
        decidedAt: null,
      },
    ],
    people: [
      {
        externalRef: `U-${status}`,
        label: "dana",
        state: "approved",
        decidedAt: null,
        avatarUrl: null,
        isOwner: false,
      },
    ],
  }) as unknown as AgentChannelsView["presences"][number];

const view = (presences: AgentChannelsView["presences"]): AgentChannelsView =>
  ({
    presences,
    posture: { transport: "socket" },
    organizationId: "org-1",
    orgIntegrations: [],
    adapter: { online: true },
  }) as unknown as AgentChannelsView;

const group = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section")!;

const renderSection = (actAsYou?: ActAsYouSlot) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactsSection actAsYou={actAsYou} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.view = undefined;
  state.peers = [];
});

describe("ContactsSection", () => {
  it("loading is a skeleton, never an empty group", () => {
    renderSection();
    expect(
      screen.queryByRole("heading", { name: "Direct messages" }),
    ).toBeNull();
  });

  it("puts every row in the group of its kind", () => {
    state.view = view([presence("active")]);
    state.peers = [
      {
        agentId: "ag-ray",
        name: "Ray",
        imageUrl: null,
        workspaceName: null,
        paused: false,
        taskOpen: false,
        myPolicy: "ask",
        theirPolicy: "ask",
        conversationId: null,
      },
    ];
    renderSection();

    const people = within(group("Direct messages"));
    // The explanation lives behind the title's info icon.
    expect(
      people.getByRole("button", { name: "About Direct messages" }),
    ).toBeDefined();
    expect(people.queryByText(/Who can DM/)).toBeNull();
    expect(
      people.getAllByTestId("contact").map((el) => el.textContent),
    ).toEqual(["U-active"]);
    // No column headers: every group reads like Agents.
    expect(people.queryByText("Can DM Donna")).toBeNull();

    const channels = within(group("Channels"));
    expect(
      channels.getAllByTestId("contact").map((el) => el.textContent),
    ).toEqual(["C-active"]);

    expect(within(group("Agents")).getByTestId("peer").textContent).toBe("Ray");
    expect(screen.queryByRole("heading", { name: "Apps" })).toBeNull();
  });

  it("reach rows come from LIVE presences only — a removed app's rows are moot", () => {
    state.view = view([presence("disabled")]);
    renderSection();
    expect(screen.queryByTestId("contact")).toBeNull();
  });

  it("an empty group says so, and Direct messages keeps its info icon", () => {
    state.view = view([]);
    renderSection();
    expect(
      screen.getByRole("button", { name: "About Direct messages" }),
    ).toBeDefined();
    expect(screen.queryByText("Workspace members")).toBeNull();
    expect(screen.getByText("No one yet.")).toBeDefined();
    expect(
      screen.getByText("Mention the agent in a channel to add it here."),
    ).toBeDefined();
    expect(screen.getByText("No other agents yet.")).toBeDefined();
    expect(screen.queryByText("None yet.")).toBeNull();
  });

  it("entitled: the slot's header, table headers on people + channels only, cells, and standalone rows", () => {
    state.view = view([presence("active")]);
    const forRow = vi.fn((group: string, ref: string) => ({
      cells: {
        reads:
          ref === "U-active" ? <span data-testid="block">{group}</span> : null,
        writes: null,
      },
      actions: [],
    }));
    renderSection({
      columns: true,
      header: <div data-testid="header" />,
      forRow,
      standaloneRows: (group) =>
        group === "people" ? [<div key="x" data-testid="standalone" />] : [],
    });
    expect(screen.getByTestId("header")).toBeTruthy();
    const people = within(group("Direct messages"));
    expect(people.getByTestId("block").textContent).toBe("people");
    expect(people.getByTestId("standalone")).toBeTruthy();
    expect(forRow).toHaveBeenCalledWith("channels", "C-active", "#room");
    expect(within(group("Channels")).queryByTestId("standalone")).toBeNull();
    for (const title of ["Direct messages", "Channels"]) {
      const header = within(group(title)).getByTestId("contact-table-header");
      expect(header.textContent).toContain("Can talk with Donna");
      expect(header.textContent).toContain("Read history");
      expect(header.textContent).toContain("Write for you");
    }
    // The Agents group has no as-you columns.
    expect(
      within(group("Agents")).queryByTestId("contact-table-header"),
    ).toBeNull();
  });

  it("unentitled (no slot): no header, no blocks, no extra rows", () => {
    state.view = view([presence("active")]);
    renderSection();
    expect(screen.queryByTestId("header")).toBeNull();
    expect(screen.queryByTestId("block")).toBeNull();
    expect(screen.queryByTestId("contact-table-header")).toBeNull();
    expect(screen.queryByTestId("contact-table-header")).toBeNull();
    expect(screen.getAllByTestId("contact")).toHaveLength(2);
  });
});
