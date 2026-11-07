// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppConnectDialog } from "./github-app-connect-dialog";

// The real hooks → typed client chain runs; only HTTP is stubbed, so the
// assertions are on the exact request the API would receive.
const mocks = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt ?? ""} />
  ),
}));

const INSTALLATION = {
  sourceConnectionId: "conn-src",
  installationId: "111",
  account: "acme",
  accountType: "Organization",
  avatarUrl: null,
  connectedHere: 0,
};

const wrap = (ui: ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {ui}
  </QueryClientProvider>
);

const renderDialog = (
  installation: Record<string, unknown> = INSTALLATION,
  agentId?: string,
  grantedConnectionIds: string[] = [],
) => {
  const onConnected = vi.fn();
  const onInstallNew = vi.fn();
  mocks.apiGet.mockImplementation(async (path: string) => {
    // Sharing is admin-only: the installations list waits on this answer.
    if (path === "/v1/org/membership") return { isAdmin: true };
    if (path.endsWith("/installations")) return [installation];
    if (agentId && path === `/v1/agents/${agentId}/grants`)
      return {
        agentId,
        mode: "grants",
        connections: grantedConnectionIds.map((connectionId) => ({
          connectionId,
        })),
        secrets: [],
      };
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.apiPost.mockResolvedValue({
    id: "conn-new",
    provider: "github-app",
    label: "acme",
  });
  mocks.apiPut.mockResolvedValue({
    agentId,
    mode: "grants",
    connections: [],
    secrets: [],
  });
  render(
    wrap(
      <GitHubAppConnectDialog
        open
        onOpenChange={() => {}}
        pageScope="workspace"
        agentId={agentId}
        onInstallNew={onInstallNew}
        onConnected={onConnected}
      />,
    ),
  );
  return { onConnected, onInstallNew };
};

afterEach(() => vi.clearAllMocks());

describe("GitHubAppConnectDialog", () => {
  const HERE = {
    ...INSTALLATION,
    origin: "organization",
    connectedHere: 1,
    connectedHereIds: ["conn-ws", "conn-org"],
  };

  it("on an agent page, turns an already-connected account on for the agent", async () => {
    const user = userEvent.setup();
    const { onConnected } = renderDialog(HERE, "agent-1");
    const row = await screen.findByRole("button", { name: /acme/ });
    expect(screen.getByText(/turn it on for this agent/)).toBeTruthy();
    await user.click(row);
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith(
        "/v1/agents/agent-1/grants/connections/conn-ws",
        { access: "default" },
      ),
    );
    // No second connection is built.
    expect(mocks.apiPost).not.toHaveBeenCalled();
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("conn-ws"));
  });

  it("says so when the agent already has it on", async () => {
    renderDialog(HERE, "agent-1", ["conn-org"]);
    expect(await screen.findByText("Already on for this agent")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /acme/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("on the Connections page the row stays informational", async () => {
    renderDialog(HERE);
    expect(
      await screen.findByText("Already available here · turn it on per agent"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /acme/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("lists the org's accounts and offers a new install", async () => {
    renderDialog();
    expect(await screen.findByText("acme")).toBeTruthy();
    expect(
      screen.getByText(/Connected in another workspace · share it/),
    ).toBeTruthy();
    expect(screen.getByText("Install on a new GitHub account")).toBeTruthy();
  });

  it("shares an account with the organization: one request, no copy, no repo step", async () => {
    const user = userEvent.setup();
    const { onConnected } = renderDialog();
    await user.click(await screen.findByText("acme"));
    expect(screen.getByText("Share acme with the organization?")).toBeTruthy();
    expect(screen.queryByText(/Selected repositories/)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Share with organization" }),
    );

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/v1/apps/github-app/connections",
      { sourceConnectionId: "conn-src" },
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("conn-new"));
  });

  it("names the agent it was opened from, so the share lands on for it", async () => {
    const user = userEvent.setup();
    renderDialog(INSTALLATION, "agent-7");
    await user.click(await screen.findByText("acme"));
    await user.click(
      screen.getByRole("button", { name: "Share with organization" }),
    );
    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(
        "/v1/apps/github-app/connections",
        { sourceConnectionId: "conn-src", agentId: "agent-7" },
      ),
    );
  });

  it("an account already available here can't be connected twice", async () => {
    const user = userEvent.setup();
    renderDialog({ ...INSTALLATION, connectedHere: 1 });
    const row = (await screen.findByText("acme")).closest("button");
    expect(row?.disabled).toBe(true);
    expect(
      screen.getByText("Already available here · turn it on per agent"),
    ).toBeTruthy();
    if (row) await user.click(row);
    expect(screen.queryByText(/Share acme with the organization/)).toBeNull();
  });

  it("hands a new GitHub account to the install flow", async () => {
    const user = userEvent.setup();
    const { onInstallNew } = renderDialog();
    await user.click(
      await screen.findByText("Install on a new GitHub account"),
    );
    expect(onInstallNew).toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
