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
}));

vi.mock("@/lib/api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
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

const renderDialog = (installation = INSTALLATION, agentId?: string) => {
  const onConnected = vi.fn();
  const onInstallNew = vi.fn();
  mocks.apiGet.mockImplementation(async (path: string) => {
    // Sharing is admin-only: the installations list waits on this answer.
    if (path === "/v1/org/membership") return { isAdmin: true };
    if (path.endsWith("/installations")) return [installation];
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.apiPost.mockResolvedValue({
    id: "conn-new",
    provider: "github-app",
    label: "acme",
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
