// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChannelsView, AgentContact, AgentPeer } from "@/lib/api";

/**
 * The Contacts section (PR 5b) composes rows from three existing queries
 * into four kind groups. Acceptance behaviors: every row lands in the group
 * of its kind (a channel contact under Channels, a person reach row under
 * People, never mixed), reach rows come only from LIVE presences, an empty
 * group says so, and loading is a skeleton (never an empty group).
 */

const state = vi.hoisted(() => ({
  view: undefined as AgentChannelsView | undefined,
  contacts: [] as AgentContact[],
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
  useAgentContacts: () => ({
    data: { contacts: state.contacts },
    isPending: false,
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
vi.mock("./person-reach-row", () => ({
  PersonReachRow: ({ person }: { person: { externalRef: string } }) => (
    <div data-testid="person-reach">{person.externalRef}</div>
  ),
}));
vi.mock("./space-reach-row", () => ({
  SpaceReachRow: ({ space }: { space: { externalRef: string } }) => (
    <div data-testid="space-reach">{space.externalRef}</div>
  ),
}));
vi.mock("./contact-row", () => ({
  ContactRow: ({ contact }: { contact: AgentContact }) => (
    <div data-testid="contact">{contact.displayName}</div>
  ),
}));
vi.mock("./peer-row", () => ({
  PeerRow: ({ peer }: { peer: AgentPeer }) => (
    <div data-testid="peer">{peer.name}</div>
  ),
}));

import { ContactsSection } from "./contacts-section";

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
        label: "@dana",
        state: "approved",
        decidedAt: null,
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

const contact = (
  kind: AgentContact["kind"],
  displayName: string,
): AgentContact => ({
  id: `c-${displayName}`,
  kind,
  externalRef: displayName,
  displayName,
  policy: "ask",
  updatedAt: "2026-09-16T00:00:00Z",
});

const group = (title: string) =>
  screen.getByRole("heading", { name: title }).closest("section")!;

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactsSection />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.view = undefined;
  state.contacts = [];
  state.peers = [];
});

describe("ContactsSection", () => {
  it("loading is a skeleton, never an empty group", () => {
    renderSection();
    expect(screen.queryByRole("heading", { name: "People" })).toBeNull();
  });

  it("puts every row in the group of its kind", () => {
    state.view = view([presence("active")]);
    state.contacts = [
      contact("person", "Dana"),
      contact("channel", "#ops"),
      contact("app", "Jira"),
    ];
    state.peers = [
      {
        agentId: "ag-ray",
        name: "Ray",
        workspaceName: null,
        paused: false,
        taskOpen: false,
        myPolicy: "ask",
        theirPolicy: "ask",
        conversationId: null,
      },
    ];
    renderSection();

    const people = within(group("People"));
    expect(people.getByText("Workspace members")).toBeDefined();
    expect(people.getByTestId("person-reach").textContent).toBe("U-active");
    expect(people.getByTestId("contact").textContent).toBe("Dana");

    const channels = within(group("Channels"));
    expect(channels.getByTestId("space-reach").textContent).toBe("C-active");
    expect(channels.getByTestId("contact").textContent).toBe("#ops");

    expect(within(group("Agents")).getByTestId("peer").textContent).toBe("Ray");
    expect(within(group("Apps")).getByTestId("contact").textContent).toBe(
      "Jira",
    );
  });

  it("reach rows come from LIVE presences only — a removed app's rows are moot", () => {
    state.view = view([presence("disabled")]);
    renderSection();
    expect(screen.queryByTestId("person-reach")).toBeNull();
    expect(screen.queryByTestId("space-reach")).toBeNull();
  });

  it("an empty group says so, and People always has the members line", () => {
    state.view = view([]);
    renderSection();
    expect(screen.getByText("Workspace members")).toBeDefined();
    expect(
      screen.getByText("Mention the agent in a channel to add it here."),
    ).toBeDefined();
    expect(screen.getByText("No other agents yet.")).toBeDefined();
    expect(screen.getByText("None yet.")).toBeDefined();
  });
});
