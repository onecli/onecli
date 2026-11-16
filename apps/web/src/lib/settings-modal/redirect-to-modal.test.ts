import { beforeEach, describe, expect, it, vi } from "vitest";

// ── redirectToSettingsModal: the old settings routes forward into the modal ──
//
// Every collaborator is stubbed: the helper's own job is picking the landing
// and building the URL. Each arm is mutation-detectable: drop the landing
// fallback and the no-workspace org redirects to "null".

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  findFirstAgent: vi.fn(),
  requireAccessibleWorkspace: vi.fn(),
  resolveOrgLanding: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
// The workspace arm runs the real `resolveWorkspaceLanding` over these.
vi.mock("@onecli/db", () => ({
  db: { agent: { findFirst: mocks.findFirstAgent } },
}));
vi.mock("@/lib/workspaces/workspace-access", () => ({
  requireAccessibleWorkspace: mocks.requireAccessibleWorkspace,
}));
vi.mock("@/lib/dashboard/org-landing", () => ({
  resolveOrgLanding: mocks.resolveOrgLanding,
}));

import { workspaceLandingPath } from "@/lib/agents/agent-order";
import { redirectToSettingsModal } from "./redirect-to-modal";

/** The first agent's default section, as the real (pure) landing helper picks it. */
const AGENT_LANDING = workspaceLandingPath("ws_1", {
  id: "ag_1",
  kind: "HOSTED",
});

const redirectedTo = async (run: () => Promise<unknown>): Promise<string> => {
  await expect(run()).rejects.toThrow(/^NEXT_REDIRECT:/);
  return mocks.redirect.mock.calls.at(-1)![0];
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAccessibleWorkspace.mockResolvedValue({
    id: "ws_1",
    organizationId: "org_1",
  });
  mocks.findFirstAgent.mockResolvedValue({ id: "ag_1", kind: "HOSTED" });
  mocks.resolveOrgLanding.mockResolvedValue("/w/ws_1/agents/ag_1");
});

describe("workspace scope", () => {
  it("forwards to the modal over the workspace's first agent", async () => {
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ workspaceId: "ws_1" }, "workspace"),
    );
    expect(url).toBe(`${AGENT_LANDING}?settings=workspace`);
    expect(mocks.requireAccessibleWorkspace).toHaveBeenCalledWith("ws_1");
  });

  it("lands on the agents index when the workspace has no agent", async () => {
    mocks.findFirstAgent.mockResolvedValue(null);
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ workspaceId: "ws_1" }, "api-keys"),
    );
    expect(url).toBe("/w/ws_1/agents?settings=api-keys");
  });

  it("carries the page's own params (a bookmarked tab) and drops a stale settings param", async () => {
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ workspaceId: "ws_1" }, "apps", {
        tab: "llms",
        settings: "billing",
        ids: ["a", "b"],
        missing: undefined,
      }),
    );
    expect(url).toBe(`${AGENT_LANDING}?tab=llms&ids=a&ids=b&settings=apps`);
  });

  it("re-encodes a crafted param instead of letting it steer the URL", async () => {
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ workspaceId: "ws_1" }, "apps", {
        tab: "x#//evil.example/?settings=billing",
      }),
    );
    expect(url).toBe(
      `${AGENT_LANDING}?tab=x%23%2F%2Fevil.example%2F%3Fsettings%3Dbilling&settings=apps`,
    );
  });
});

describe("organization scope", () => {
  it("forwards to the modal over the org's landing", async () => {
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ organizationId: "org_1" }, "members"),
    );
    expect(url).toBe("/w/ws_1/agents/ag_1?settings=members");
    expect(mocks.resolveOrgLanding).toHaveBeenCalledWith("org_1");
  });

  it("opens the modal over the workspaces page when the viewer has no workspace to land in", async () => {
    mocks.resolveOrgLanding.mockResolvedValue(null);
    const url = await redirectedTo(() =>
      redirectToSettingsModal({ organizationId: "org_1" }, "members"),
    );
    expect(url).toBe("/org/org_1/workspaces?settings=members");
  });
});

// Stripe's checkout and portal send the admin back to `/org/<id>/billing`
// (`dashboardUrl` in the billing routes). The route page forwards into the
// modal; `?checkout=success` must survive, it is what re-reads the plan.
describe("the billing route Stripe returns to", () => {
  it("opens Billing & usage with the checkout result intact", async () => {
    const { default: BillingRoutePage } =
      await import("@/app/(dashboard)/org/[orgId]/(admin)/billing/page");
    const url = await redirectedTo(() =>
      BillingRoutePage({
        params: Promise.resolve({ orgId: "org_1" }),
        searchParams: Promise.resolve({ checkout: "success" }),
      }),
    );
    expect(url).toBe("/w/ws_1/agents/ag_1?checkout=success&settings=billing");
  });
});

// Index and pre-tab URLs used to forward to another old URL, which is itself
// a redirect now: two hops before the page. Each must go straight to the
// modal page its old target opens.
describe("old index URLs forward in one hop", () => {
  const ws = Promise.resolve({ workspaceId: "ws_1" });
  const org = Promise.resolve({ orgId: "org_1" });
  const query = (q: Record<string, string> = {}) => Promise.resolve(q);
  // Each case renders its page with that page's own props, so the table
  // type-checks against the real signatures.
  const cases: { name: string; run: () => Promise<unknown>; to: string }[] = [
    {
      name: "/w/<id>/settings",
      run: async () =>
        (
          await import("@/app/(dashboard)/w/[workspaceId]/settings/page")
        ).default({ params: ws }),
      to: `${AGENT_LANDING}?settings=workspace`,
    },
    {
      name: "/w/<id>/connections/apps",
      run: async () =>
        (
          await import("@/app/(dashboard)/w/[workspaceId]/connections/apps/page")
        ).default({ params: ws }),
      to: `${AGENT_LANDING}?settings=apps`,
    },
    {
      name: "/w/<id>/connections/secrets",
      run: async () =>
        (
          await import("@/app/(dashboard)/w/[workspaceId]/connections/(tabs)/secrets/page")
        ).default({ params: ws, searchParams: query({ q: "stripe" }) }),
      to: `${AGENT_LANDING}?q=stripe&tab=custom&settings=apps`,
    },
    {
      name: "/w/<id>/connections/secrets?create=openai (an LLM key)",
      run: async () =>
        (
          await import("@/app/(dashboard)/w/[workspaceId]/connections/(tabs)/secrets/page")
        ).default({ params: ws, searchParams: query({ create: "openai" }) }),
      to: `${AGENT_LANDING}?create=openai&tab=llms&settings=apps`,
    },
    {
      name: "/org/<id>/settings",
      run: async () =>
        (
          await import("@/app/(dashboard)/org/[orgId]/(admin)/settings/page")
        ).default({ params: org }),
      to: "/w/ws_1/agents/ag_1?settings=general",
    },
    {
      name: "/org/<id>/settings/channels (the Slack install return)",
      run: async () =>
        (
          await import("@/app/(dashboard)/org/[orgId]/(admin)/settings/channels/page")
        ).default({ params: org, searchParams: query({ connected: "slack" }) }),
      to: "/w/ws_1/agents/ag_1?connected=slack&settings=slack",
    },
    {
      name: "/org/<id>/app-availability",
      run: async () =>
        (
          await import("@/app/(dashboard)/org/[orgId]/(admin)/app-availability/page")
        ).default({ params: org }),
      to: "/w/ws_1/agents/ag_1?settings=shared-apps",
    },
    {
      name: "/org/<id>/settings/global-connections/apps",
      run: async () =>
        (
          await import("@/app/(dashboard)/org/[orgId]/(admin)/settings/global-connections/apps/page")
        ).default({ params: org }),
      to: "/w/ws_1/agents/ag_1?settings=shared-apps",
    },
  ];

  it.each(cases)("$name", async ({ run, to }) => {
    expect(await redirectedTo(run)).toBe(to);
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });
});
