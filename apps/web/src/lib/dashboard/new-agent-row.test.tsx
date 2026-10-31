// @vitest-environment jsdom
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
import { SidebarProvider } from "@onecli/ui/components/sidebar";
import type { AgentKind } from "@/lib/api/types";

/**
 * The sidebar's "New agent" row: the same create door as the agents page
 * (one shared flow), as a sidebar row — quota-gated on cloud like the page's
 * button, and with a chevron only where a second path genuinely exists.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  org: { byoLegacy: false, byoEnabled: false } as
    | { byoLegacy: boolean; byoEnabled: boolean }
    | undefined,
  orgPending: false,
  atLimit: false,
  // Which create dialogs are MOUNTED (open or not): each carries its own
  // reads, so a closed one on every page must not exist yet.
  mounted: new Set<string>(),
}));

vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
  useHomeDurabilityMessage: () => null,
}));
vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ data: state.org, isPending: state.orgPending }),
}));
// The dialogs themselves have their own suites; here only WHICH opens, and
// WHETHER it is mounted at all before the first click.
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/agents/_components/create-agent-dialog",
  () => ({
    CreateAgentDialog: ({ open }: { open: boolean }) => {
      state.mounted.add("byo");
      return open ? <div>byo dialog</div> : null;
    },
  }),
);
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/agents/_components/new-hosted-agent-dialog",
  () => ({
    NewHostedAgentDialog: ({ open }: { open: boolean }) => {
      state.mounted.add("hosted");
      return open ? <div>hosted dialog</div> : null;
    },
  }),
);
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/agents/_components/hosted-onboarding-dialog",
  () => ({
    HostedOnboardingDialog: ({ open }: { open: boolean }) =>
      open ? <div>onboarding call</div> : null,
  }),
);
vi.mock("@/ee/billing/use-plan-usage", () => ({
  useResourceQuota: () => ({
    current: state.atLimit ? 10 : 1,
    limit: 10,
    plan: "pro",
    atLimit: state.atLimit,
    organizationId: "org-1",
  }),
}));
vi.mock("@/ee/billing/_components/quota-limit-dialog", () => ({
  QuotaLimitDialog: ({ open }: { open: boolean }) =>
    open ? <div>Plan limit reached</div> : null,
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const { NewAgentRow } = await import("./new-agent-row");

const renderRow = (
  agents: { kind: AgentKind }[] | undefined = [],
  agentsPending = false,
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarProvider>
        <ul>
          <NewAgentRow agents={agents} agentsPending={agentsPending} />
        </ul>
      </SidebarProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.org = { byoLegacy: false, byoEnabled: false };
  state.orgPending = false;
  state.atLimit = false;
});
afterEach(cleanup);

describe("the sidebar New agent row", () => {
  it("mounts no create dialog until one is asked for (no reads on every page)", async () => {
    state.mounted.clear();
    renderRow();
    expect([...state.mounted]).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect([...state.mounted]).toEqual(["hosted"]);
  });

  it("opens hosted creation for a hosted-world org, with no chevron", async () => {
    renderRow();
    expect(
      screen.queryByRole("button", { name: /more ways to create an agent/i }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
  });

  it("opens BYO creation for a BYO-world org, hosted behind the chevron as the call", async () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    renderRow([{ kind: "byo" }]);
    await userEvent.click(screen.getByRole("button", { name: /^new agent$/i }));
    expect(screen.getByText("byo dialog")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // A BYO-world org's move to hosted books a human, never hosted creation.
    expect(screen.getByText("onboarding call")).toBeInTheDocument();
    expect(screen.queryByText("hosted dialog")).toBeNull();
  });

  it("offers a MIXED-world org BYO creation behind the chevron", async () => {
    state.org = { byoLegacy: false, byoEnabled: true };
    renderRow();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new byo agent/i }),
    );
    expect(screen.getByText("byo dialog")).toBeInTheDocument();
  });

  it("is held (disabled) until the door is known", () => {
    state.orgPending = true;
    renderRow();
    expect(screen.getByRole("button", { name: /new agent/i })).toBeDisabled();
    cleanup();
    state.orgPending = false;
    renderRow(undefined, true);
    expect(screen.getByRole("button", { name: /new agent/i })).toBeDisabled();
  });

  it("lets the plan's agent quota stop creation", async () => {
    state.atLimit = true;
    renderRow();
    await userEvent.click(screen.getByRole("button", { name: /new agent/i }));
    expect(screen.getByText("Plan limit reached")).toBeInTheDocument();
    expect(screen.queryByText("hosted dialog")).toBeNull();
  });
});
