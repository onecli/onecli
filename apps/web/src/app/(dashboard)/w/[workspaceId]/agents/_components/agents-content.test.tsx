// @vitest-environment jsdom
import type { AgentKind } from "@/lib/api/types";
import type { CreateDoorPrimary } from "./agent-create-door";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { HostedAvailability } from "@/lib/agents/availability";

/**
 * The agents page's create door, end to end through the real page.
 *
 * `create-door.test.ts` proves the decision and `agent-create-door.test.tsx`
 * proves the control, but the thing a user actually feels lives HERE: which
 * dialog opens. On cloud the org's creation world (`byoLegacy`, §3.10 as
 * re-decided 2026-08-23) picks the door: a hosted-world org goes straight
 * into hosted creation, a BYO-world org keeps the legacy flow with the
 * onboarding call behind the chevron — a wiring claim that neither lower
 * test can make.
 *
 * This file is the CLOUD arm (the org world and the booking funnel are
 * cloud-only); the onprem arm lives in `agents-content.onprem.test.tsx`.
 */

// IS_CLOUD is resolved at module load — pin the edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  agents: [] as
    | { id: string; kind: AgentKind; name: string; createdAt?: string }[]
    | undefined,
  availability: "ready" as HostedAvailability,
  // The org's creation world; undefined = the read failed (data absent,
  // isPending false), which must fall back, never lock the page.
  org: { byoLegacy: false, byoEnabled: false } as
    | { byoLegacy: boolean; byoEnabled: boolean }
    | undefined,
  orgPending: false,
  quota: {
    current: 1,
    limit: 10,
    plan: "pro",
    atLimit: false,
    organizationId: "org-1",
  },
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents, isPending: false }),
  useCreateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateHostedAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
    error: null,
  }),
}));

vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => state.availability,
  useHomeDurabilityMessage: () => null,
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ data: state.org, isPending: state.orgPending }),
}));

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
  usePathname: () => "/w/ws-1/agents",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ workspaceId: "ws-1" }),
}));

// The EE quota gate, whose button IS the production primary (see below).
// Its quota is read off the cached plan usage, not fetched per button.
vi.mock("@/ee/billing/use-plan-usage", () => ({
  useResourceQuota: () => state.quota,
}));
vi.mock("@/ee/billing/_components/quota-limit-dialog", () => ({
  QuotaLimitDialog: ({ open }: { open: boolean }) =>
    open ? <div>Plan limit reached</div> : null,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const { AgentsContent } = await import("./agents-content");
const { AgentCreateControl } = await import("./agent-create-control");
const { useAgentCreateFlow } = await import("./use-agent-create-flow");
const { CreateAgentButton } =
  await import("@/lib/agents/_components/create-agent-button");

/**
 * The create door exactly as every entry point mounts it (the agents page's
 * empty state, the sidebar's New agent row): the shared flow + control. The
 * page itself forwards to the first agent whenever agents exist, so the door
 * states that need agents in the workspace are exercised through this.
 */
const Door = ({
  renderCreateButton,
}: {
  renderCreateButton?: (primary: CreateDoorPrimary) => React.ReactNode;
}) => {
  const flow = useAgentCreateFlow(state.agents, false);
  return (
    <AgentCreateControl flow={flow} renderCreateButton={renderCreateButton} />
  );
};
const renderDoor = (props?: React.ComponentProps<typeof Door>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Door {...props} />
    </QueryClientProvider>,
  );

// The create dialogs (mounted on their first open) embed SecretDialog for the
// LLM-key guided setup, which reads the query client — so the tree needs a
// real QueryClient even with every page hook mocked.
const renderPage = (props?: React.ComponentProps<typeof AgentsContent>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentsContent {...props} />
    </QueryClientProvider>,
  );

/**
 * PRODUCTION composition. The routed page (`app/.../agents/page.tsx` →
 * `lib/agents/agents-page.tsx`) ALWAYS passes `renderCreateButton`, so the
 * bare `renderPage()` above exercises a fallback that ships to nobody.
 * These render what a cloud user actually gets.
 */
const renderComposed = () =>
  renderDoor({
    renderCreateButton: (primary) => <CreateAgentButton {...primary} />,
  });

const agent = (kind: AgentKind, id = `ag-${kind}`) => ({
  id,
  kind,
  name: `${kind} agent`,
});

beforeEach(() => {
  state.agents = [];
  state.availability = "ready";
  state.org = { byoLegacy: false, byoEnabled: false };
  state.orgPending = false;
  state.quota = {
    current: 1,
    limit: 10,
    plan: "pro",
    atLimit: false,
    organizationId: "org-1",
  };
});
afterEach(cleanup);

describe("the agents page is a door, not a roster", () => {
  beforeEach(() => routerReplace.mockClear());

  it("forwards to the OLDEST agent's first section when agents exist", () => {
    state.agents = [
      {
        id: "ag-new",
        kind: "byo",
        name: "new",
        createdAt: "2026-10-02T00:00:00Z",
      },
      {
        id: "ag-old",
        kind: "hosted",
        name: "old",
        createdAt: "2026-10-01T00:00:00Z",
      },
    ];
    renderPage();
    expect(routerReplace).toHaveBeenCalledWith("/w/ws-1/agents/ag-old/chat");
    // No cards, no list: the page holds a skeleton while it forwards.
    expect(screen.queryByText("new")).toBeNull();
    expect(screen.queryByText("old")).toBeNull();
  });

  it("shows the create door, and does not forward, in an empty workspace", () => {
    renderPage();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByText(/no agents yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeTruthy();
  });
});

describe("the agents page create door", () => {
  it("takes a NEW user straight into hosted creation", async () => {
    renderDoor();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    // The hosted create dialog — a brief, not a booking.
    expect(
      await screen.findByRole("heading", { name: /new agent/i }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("keeps a BYO-world org's primary button on the access-token flow", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [agent("byo")];
    renderDoor();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    // The BYO dialog is the one with an SDK identifier field.
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("offers a BYO-world org the onboarding call behind the chevron", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [agent("byo")];
    renderDoor();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // A booking, NOT the create form: this is the whole point of the change.
    const book = await screen.findByRole("link", { name: /book 15 minutes/i });
    expect(book.getAttribute("href")).toBe("https://cal.com/onecli/15min");
    expect(book.getAttribute("target")).toBe("_blank");
    // Pin BOTH rel tokens: dropping noreferrer would keep a contains-check
    // green while silently shedding the Referer suppression.
    expect(book.getAttribute("rel")?.split(" ").sort()).toEqual([
      "noopener",
      "noreferrer",
    ]);
    expect(screen.queryByPlaceholderText(/Support Triage/i)).toBeNull();
  });

  it("sends a hosted-only workspace to creation, never to the call", async () => {
    state.agents = [agent("hosted")];
    renderDoor();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
  });

  it("gives a HOSTED-world org the hosted door even beside its old BYO agents", async () => {
    // The org world, not the workspace's agents, decides (§3.10 re-decided):
    // the old agents keep working, but creation is hosted-only now.
    state.org = { byoLegacy: false, byoEnabled: false };
    state.agents = [agent("byo")];
    renderDoor();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
  });

  it("keeps a MIXED-world org's primary on hosted CREATION — never the call", async () => {
    // The mixed world (byoEnabled, 2026-08-29): these orgs are already
    // onboarded — their hosted primary opens the create dialog directly.
    state.org = { byoLegacy: false, byoEnabled: true };
    state.agents = [agent("byo")];
    renderDoor();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("offers a MIXED-world org BYO creation behind the chevron — the real dialog, no call", async () => {
    state.org = { byoLegacy: false, byoEnabled: true };
    state.agents = [];
    renderDoor();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new byo agent/i }),
    );
    // The BYO dialog is the one with an SDK identifier field — and it is
    // creation, not the onboarding booking.
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });

  it("gives a BYO-world org the split door even in a FRESH workspace", async () => {
    // The exact miss §3.10 item 4 called out: a BYO-world org's new workspace
    // must not be wrongly hosted-only.
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [];
    renderDoor();
    expect(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
  });

  it("holds the page on a skeleton while the org world is still loading", () => {
    // The world decides the PRIMARY button; painting one and swapping it is
    // the broken-product transition the door exists to prevent.
    state.orgPending = true;
    renderPage();
    expect(
      screen.queryByRole("button", { name: /create agent|new agent/i }),
    ).toBeNull();
  });

  it("falls back to the workspace-derived door when the org read FAILS", async () => {
    // Failed ≠ pending: data absent with isPending false must render (the
    // permanent-skeleton hazard), and the legacy workspace rule is the
    // fallback that always works.
    state.org = undefined;
    state.agents = [agent("byo")];
    renderDoor();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeTruthy();
  });

  it("leaves a BYO-world runner-less deployment exactly as it was: one BYO button", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.availability = "absent";
    state.agents = [agent("byo")];
    renderDoor();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /create agent/i }),
    );
    expect(screen.getByLabelText(/identifier/i)).toBeTruthy();
  });

  it("shows exactly ONE create button in every state — the point of the merge", () => {
    for (const [availability, agents, byoLegacy, byoEnabled] of [
      ["ready", [], false, false],
      ["ready", [agent("byo")], false, false],
      ["ready", [], true, false],
      ["ready", [agent("byo")], true, false],
      ["offline", [agent("byo")], true, false],
      ["absent", [agent("byo")], true, false],
      ["absent", [agent("byo")], false, false],
      ["loading", [], false, false],
      // The mixed world: hosted primary + BYO chevron is still ONE control.
      ["ready", [], false, true],
      ["ready", [agent("byo")], false, true],
      ["absent", [agent("byo")], false, true],
      ["loading", [], false, true],
    ] as const) {
      state.availability = availability;
      state.agents = [...agents];
      state.org = { byoLegacy, byoEnabled };
      renderDoor();
      const creates = screen
        .getAllByRole("button")
        .filter((b) => /create agent|new agent/i.test(b.textContent ?? ""));
      expect(creates).toHaveLength(1);
      cleanup();
    }
  });

  it("tells an empty workspace about the button it can actually see", () => {
    renderPage();
    // No "connect your own with an access token" — that door isn't rendered.
    expect(screen.getByText(/start chatting/i)).toBeTruthy();
    expect(screen.queryByText(/access token/i)).toBeNull();
  });

  it("still renders a page when the agent read FAILS", () => {
    // An error leaves data undefined with isPending false. Reading that as
    // "undefined, so render nothing" paints a blank page — no cards, no empty
    // state, no create button — which is worse than any error message.
    // Hosted-world arm: the org column already decided the door, so the
    // failed agents read changes nothing about the primary.
    state.agents = undefined;
    renderPage();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeTruthy();
    expect(screen.getByText(/no agents yet/i)).toBeTruthy();
    expect(screen.getByText(/start chatting/i)).toBeTruthy();
    cleanup();
    // BYO-world arm: the visible primary is BYO, and the copy must describe
    // it, not the hosted flow behind the chevron.
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = undefined;
    renderPage();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeTruthy();
    expect(screen.getByText(/access token/i)).toBeTruthy();
  });
});

/**
 * The composition cloud actually ships. Everything above renders the fallback
 * primary button; the routed page never does.
 */
describe("the create door as the routed page composes it", () => {
  it("routes a NEW user's quota-gated button into hosted creation", async () => {
    renderComposed();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByPlaceholderText(/Support Triage/i)).toBeTruthy();
  });

  it("keeps the split shape when the EE button is the primary", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [agent("byo")];
    renderComposed();
    // The quota button must carry the flat inner edge through, or the pair
    // renders as two separate pills with a seam floating between them.
    const primary = screen.getByRole("button", { name: /create agent/i });
    expect(primary.className).toContain("rounded-r-none");
    // And the chevron still reaches hosted, through the composed primary.
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    expect(
      await screen.findByRole("link", { name: /book 15 minutes/i }),
    ).toBeTruthy();
  });

  it("lets the quota stop creation instead of opening a dialog", async () => {
    state.quota = { ...state.quota, atLimit: true, current: 10 };
    renderComposed();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(await screen.findByText(/plan limit reached/i)).toBeTruthy();
    // The create dialog must NOT have opened behind the paywall.
    expect(screen.queryByPlaceholderText(/Support Triage/i)).toBeNull();
  });

  it("does not let the quota block the onboarding CALL — it costs no slot", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [agent("byo")];
    state.quota = { ...state.quota, atLimit: true, current: 10 };
    renderComposed();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // Booking a conversation is not creating a resource; a full plan must
    // never be the reason someone can't ask us about upgrading.
    expect(
      await screen.findByRole("link", { name: /book 15 minutes/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/plan limit reached/i)).toBeNull();
  });
});
