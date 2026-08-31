// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `?new=1` door (the Get Started button's landing): it must open the
 * create dialog EVERY time the param arrives, not just the first time in a
 * mount. A one-shot ref used to guard this and silently broke the second
 * press, since pressing Get Started again re-adds the param without
 * remounting the page.
 */

// IS_CLOUD is resolved at module load — pin the edition before imports. The
// migration gate this suite covers is cloud-only (a self-host deployment runs
// its own runner, so there is nothing to migrate).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  availability: "ready" as string,
  agents: [] as { id: string; kind: string; name: string }[],
  agentsPending: false,
  org: { byoLegacy: false, byoEnabled: false } as
    | { byoLegacy: boolean; byoEnabled: boolean }
    | undefined,
  orgPending: false,
}));

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  /** The live `onOpenChange` of whichever dialog is mounted — the test needs
   *  it to dismiss the dialog the way a user's Cancel does. */
  closeHosted: undefined as undefined | (() => void),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => state.params,
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  usePathname: () => "/w/w1/agents",
}));
// The roster's cards are not what this suite is about (and they read the route
// and format timestamps) — same stand-in the sibling suite uses.
vi.mock("./agent-card", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => (
    <div>{agent.name}</div>
  ),
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({ data: state.agents, isPending: state.agentsPending }),
}));
vi.mock("@/hooks/use-grants", () => ({
  useGrantsSummary: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => state.availability,
  useHomeDurabilityMessage: () => null,
}));
vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ data: state.org, isPending: state.orgPending }),
}));
vi.mock("./create-agent-dialog", () => ({
  CreateAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div>byo dialog</div> : null,
}));
vi.mock("./hosted-onboarding-dialog", () => ({
  HostedOnboardingDialog: ({ open }: { open: boolean }) =>
    open ? <div>onboarding call</div> : null,
}));
vi.mock("./new-hosted-agent-dialog", () => ({
  NewHostedAgentDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    mocks.closeHosted = () => onOpenChange(false);
    return open ? <div>hosted dialog</div> : null;
  },
}));

const { AgentsContent } = await import("./agents-content");

beforeEach(() => {
  state.params = new URLSearchParams();
  state.availability = "ready";
  state.agents = [];
  state.agentsPending = false;
  state.org = { byoLegacy: false, byoEnabled: false };
  state.orgPending = false;
  mocks.replace.mockClear();
  mocks.closeHosted = undefined;
});

describe("the ?new=1 create door", () => {
  it("opens the hosted flow and strips the param", () => {
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents", {
      scroll: false,
    });
  });

  it("opens the BYO flow for a BYO-world org with no hosted surface", () => {
    state.org = { byoLegacy: true, byoEnabled: false };
    state.params = new URLSearchParams("new=1");
    state.availability = "absent";
    render(<AgentsContent />);
    expect(screen.getByText("byo dialog")).toBeInTheDocument();
  });

  it("keeps a HOSTED-world org in the hosted flow even on a runner-less read", () => {
    // The effect mirrors the page's primary (the door), never raw
    // availability: a hosted-world org must not be dropped into BYO creation
    // the server would refuse.
    state.params = new URLSearchParams("new=1");
    state.availability = "absent";
    render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
    expect(screen.queryByText("byo dialog")).not.toBeInTheDocument();
  });

  it("waits for availability where the door depends on it (BYO world)", () => {
    // A BYO-world door is byo vs byo-with-hosted BY availability, so acting
    // early would guess which dialog to open.
    state.org = { byoLegacy: true, byoEnabled: false };
    state.params = new URLSearchParams("new=1");
    state.availability = "loading";
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("byo dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding call")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does NOT stall a hosted-world org on the availability read", () => {
    // A hosted-world door ignores availability entirely, and a failed
    // instance read parks it on "loading" forever — the deep link must not
    // dangle while the page paints a working hosted door.
    state.params = new URLSearchParams("new=1");
    state.availability = "loading";
    render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
  });

  it("keeps other params when it strips its own", () => {
    state.params = new URLSearchParams("new=1&foo=bar");
    render(<AgentsContent />);
    expect(mocks.replace).toHaveBeenCalledWith("/w/w1/agents?foo=bar", {
      scroll: false,
    });
  });

  it("opens again when the param returns to an already-mounted page", () => {
    state.params = new URLSearchParams("new=1");
    const view = render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();

    // The param is stripped (the effect's own `router.replace`), then the user
    // dismisses the dialog — the exact state after a first Get Started press
    // that went nowhere.
    state.params = new URLSearchParams();
    view.rerender(<AgentsContent />);
    act(() => mocks.closeHosted?.());
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();

    // Pressing Get Started again re-adds it, with no remount in between.
    state.params = new URLSearchParams("new=1");
    view.rerender(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
  });

  it("books the onboarding call for a BYO-world org, never hosted creation", () => {
    // A BYO-world org's move to hosted is a MIGRATION (§3.10 as re-decided):
    // its hosted entry books a human. Arriving by `?new=1` must not be a way
    // around that gate — this opened the hosted dialog directly before,
    // quietly bypassing it for anyone following the link.
    state.org = { byoLegacy: true, byoEnabled: false };
    state.agents = [{ id: "a1", kind: "byo", name: "legacy agent" }];
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.getByText("onboarding call")).toBeInTheDocument();
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
  });

  it("lands a MIXED-world org's hosted-intent link in hosted CREATION, not the call", () => {
    // The mixed world (byoEnabled, 2026-08-29) is already onboarded: `?new=1`
    // must open the hosted create dialog, exactly like the hosted world —
    // and not stall on availability, which its door ignores.
    state.org = { byoLegacy: false, byoEnabled: true };
    state.agents = [{ id: "a1", kind: "byo", name: "legacy agent" }];
    state.params = new URLSearchParams("new=1");
    state.availability = "loading";
    render(<AgentsContent />);
    expect(screen.getByText("hosted dialog")).toBeInTheDocument();
    expect(screen.queryByText("onboarding call")).not.toBeInTheDocument();
    expect(screen.queryByText("byo dialog")).not.toBeInTheDocument();
  });

  it("waits for the agent list before choosing a door", () => {
    // `createDoor` reads an undefined list as "still loading" and falls back
    // to BYO, so acting before it resolves would show a legacy user the wrong
    // door on first paint.
    state.agentsPending = true;
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding call")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("waits for the org world before choosing a door", () => {
    // The world decides between hosted creation and the onboarding call —
    // firing before it resolves would route a BYO-world org's link into
    // hosted creation.
    state.orgPending = true;
    state.params = new URLSearchParams("new=1");
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding call")).not.toBeInTheDocument();
    expect(screen.queryByText("byo dialog")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does nothing without the param", () => {
    render(<AgentsContent />);
    expect(screen.queryByText("hosted dialog")).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
