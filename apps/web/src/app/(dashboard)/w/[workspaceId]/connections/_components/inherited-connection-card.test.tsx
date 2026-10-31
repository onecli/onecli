// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InheritedConnectionCard } from "./inherited-connection-card";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getActiveOrganizationId } from "@/lib/workspaces/actions";

const access = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/lib/workspaces/actions", () => ({
  getActiveOrganizationId: vi.fn(),
}));
vi.mock("@/hooks/use-org", () => ({
  useOrgMembership: () => ({ data: { isAdmin: access.isAdmin } }),
}));
vi.mock("@/lib/gateway-url", () => ({
  getGatewayApiUrl: () => "https://gateway.example",
}));
vi.mock("@/lib/gateway-auth", () => ({
  getGatewayFetchOptions: async () => ({
    headers: { "X-Workspace-Id": "ambient-workspace" },
    credentials: "include",
  }),
}));

beforeEach(() => {
  access.isAdmin = true;
  vi.mocked(getActiveOrganizationId).mockResolvedValue("actual-organization");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

// Unit boundary: the agent rows bring their own data graph.
vi.mock("./connection-agent-rows", () => ({
  ConnectionAgentRows: () => null,
}));

const orgShared = (metadata: Record<string, unknown> | null) => ({
  id: "conn-org",
  provider: "github",
  label: "octo",
  scope: "organization",
  status: "connected",
  scopes: [],
  metadata,
  connectedAt: "2026-10-01T00:00:00Z",
});

describe("InheritedConnectionCard", () => {
  it("tests an inherited connection on a workspace page with the actual org header, never the ambient workspace", async () => {
    window.history.replaceState(
      {},
      "",
      "/w/ambient-workspace/connections/apps/postgres",
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, superuser: false })),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InheritedConnectionCard
          connection={{ ...orgShared(null), provider: "postgres" }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );
    await screen.findByText("Connection verified");
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example/v1/connections/conn-org/test");
    const headers = new Headers(options?.headers);
    expect(headers.get("X-Organization-Id")).toBe("actual-organization");
    expect(headers.has("X-Workspace-Id")).toBe(false);
    expect(options?.body).toBeUndefined();
  });
  it("hides inherited checks from non-admins even when the org is resolved", async () => {
    access.isAdmin = false;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InheritedConnectionCard
          connection={{ ...orgShared(null), provider: "postgres" }}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Test connection" }),
    ).toBeNull();
  });
  it("keeps non-database inherited connections unchanged", () => {
    render(<InheritedConnectionCard connection={orgShared(null)} />);
    expect(
      screen.queryByRole("button", { name: "Test connection" }),
    ).toBeNull();
  });
  it("shows an organization's refusal of an org-shared account, read-only", () => {
    render(
      <InheritedConnectionCard
        connection={orgShared({
          githubOrgAccess: { acme: { reason: "sso_required" } },
        })}
      />,
    );
    expect(screen.getByText("1 GitHub org needs access")).toBeInTheDocument();
    expect(screen.getByText(/SSO sign-in needed/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sign In to acme SSO/ }),
    ).toBeInTheDocument();
    // Only an organization admin can re-authorize an org-shared account.
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("shows nothing extra without a refusal", () => {
    render(<InheritedConnectionCard connection={orgShared(null)} />);
    expect(screen.queryByText(/needs access/)).toBeNull();
  });

  // Reconnecting with the other level replaces the account, so the card
  // must say which kind of token the account holds.
  it("names the access level of an app that offers more than one", () => {
    render(
      <InheritedConnectionCard
        connection={{
          ...orgShared({ accessLevel: "user" }),
          provider: "attio",
        }}
      />,
    );
    expect(screen.getByText(/Personal access/)).toBeInTheDocument();
  });

  it("names a GitHub organization as GitHub's, never as a OneCLI organization", () => {
    render(
      <InheritedConnectionCard
        connection={{
          ...orgShared({ accountType: "Organization" }),
          provider: "github-app",
        }}
      />,
    );
    expect(screen.getByText(/GitHub organization/)).toBeInTheDocument();
    expect(screen.queryByText(/^Organization$/)).toBeNull();
  });

  it("names no level for a connection made before it was recorded", () => {
    render(
      <InheritedConnectionCard
        connection={{ ...orgShared(null), provider: "attio" }}
      />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/Workspace access|Personal access/)).toBeNull();
  });
});
