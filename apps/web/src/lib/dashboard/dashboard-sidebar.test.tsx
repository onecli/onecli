// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@onecli/ui/components/sidebar";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * THE AUTO-HIDE PROOF, cloud arm (§3.13 — the v2→main merge gate's web
 * half). Every layer between the wire and the DOM runs for real: the mocked
 * transport answers `/v1/instance`, the real `useInstance` caches it, the
 * real availability module translates it, and the real sidebar renders the
 * consequence. This is the ONE test that would catch a regression wiring the
 * sidebar past `showsHostedSurface` — each layer's own unit tests pass with
 * that wire cut.
 *
 * Cloud `absent` renders no hosted chrome at all (§3.13 as amended
 * 2026-08-16) — the workspace's own (BYO) agents still list,
 * availability-independent since the same day's amendment. The onprem arm
 * lives in dashboard-sidebar.onprem.test.tsx.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const state = vi.hoisted(() => ({
  runners: undefined as InstanceInfo["runners"],
  pathname: "/org/o1/workspaces",
  agents: [] as Array<{ id: string; name: string; kind: string }>,
}));

// The ONLY data mock: the wire. Everything from here to the DOM is real.
vi.mock("@/lib/api/instance", () => ({
  get: async (): Promise<InstanceInfo> => ({
    edition: "cloud",
    entitled: true,
    version: "test",
    ...(state.runners && { runners: state.runners }),
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

// Structural chrome the sidebar imports but this proof is not about.
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));
vi.mock("@/ee/team/actions", () => ({
  getUserOrgRole: async () => "owner",
}));
vi.mock("@/ee/billing/_components/sidebar-quota", () => ({
  SidebarQuota: () => null,
}));
vi.mock("@/lib/dashboard/nav-user", () => ({
  NavUser: () => null,
}));
vi.mock("@/lib/dashboard/org-switcher", () => ({
  OrgSwitcher: () => null,
}));
vi.mock("@/hooks/use-agents", () => ({
  useAgentsForWorkspace: () => ({ data: state.agents, isPending: false }),
}));

const { DashboardSidebar } = await import("./dashboard-sidebar");

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

const renderSidebar = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SidebarProvider>
        <DashboardSidebar />
      </SidebarProvider>
    </QueryClientProvider>,
  );

const chatLinks = () =>
  screen
    .queryAllByRole("link")
    .filter((link) => link.getAttribute("href")?.includes("/chat"));

beforeEach(() => {
  state.runners = undefined;
  state.pathname = "/org/o1/workspaces";
  state.agents = [];
});

describe("org tier: the hosted-only entries follow the availability wire", () => {
  it("no runner ever registered: Channels and Skills are absent", async () => {
    state.runners = { registered: false, online: false };
    renderSidebar();
    // "Members" appears once the role resolves — the settle point.
    await screen.findByText("Members");
    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.queryByText("Skills")).toBeNull();
  });

  it("an OLDER api answering without `runners` reads as absent, never a crash", async () => {
    state.runners = undefined;
    renderSidebar();
    await screen.findByText("Members");
    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.queryByText("Skills")).toBeNull();
  });

  it("a registered-but-offline runner keeps the entries — offline is not absent", async () => {
    state.runners = { registered: true, online: false };
    renderSidebar();
    await screen.findByText("Channels");
    expect(screen.getByText("Skills")).toBeDefined();
  });

  it("an online runner shows the entries", async () => {
    state.runners = { registered: true, online: true };
    renderSidebar();
    await screen.findByText("Channels");
    expect(screen.getByText("Skills")).toBeDefined();
  });

  it("the footer never shows a version line on cloud", async () => {
    state.runners = { registered: true, online: true };
    renderSidebar();
    // Settle on the wire-driven nav, then prove the self-host-only version
    // caption (the wire reports version "test") stayed out of the footer.
    await screen.findByText("Channels");
    expect(screen.queryByText("vtest")).toBeNull();
  });
});

describe("workspace tier: the agent rows through the real wire", () => {
  it("absent lists the workspace's BYO agents with nothing HOSTED actionable", async () => {
    // The 2026-08-16 amendment: the agent list is availability-independent —
    // a runnerless cloud deployment still shows the user's own agents.
    state.runners = { registered: false, online: false };
    state.pathname = "/w/p1/overview";
    state.agents = [{ id: "ag-b", name: "Laptop", kind: "byo" }];
    renderSidebar();
    const byoRow = await screen.findByRole("link", { name: /Laptop/ });
    expect(byoRow.getAttribute("href")).toContain("/agents/ag-b/connections");
    expect(chatLinks()).toEqual([]);
  });

  it("ready renders real thread links", async () => {
    state.runners = { registered: true, online: true };
    state.pathname = "/w/p1/overview";
    state.agents = [{ id: "ag-1", name: "Support Triage", kind: "hosted" }];
    renderSidebar();
    const thread = await screen.findByRole("link", { name: /Support Triage/ });
    expect(thread.getAttribute("href")).toContain("/agents/ag-1/chat");
  });
});
