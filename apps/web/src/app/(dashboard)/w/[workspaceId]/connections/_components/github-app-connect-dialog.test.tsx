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
  repositorySelection: "all",
  origin: "another_workspace",
  connectedHere: 0,
};

const wrap = (ui: ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {ui}
  </QueryClientProvider>
);

const renderDialog = () => {
  const onConnected = vi.fn();
  const onInstallNew = vi.fn();
  mocks.apiGet.mockImplementation(async (path: string) => {
    // Sharing is admin-only: the installations list waits on this answer.
    if (path === "/v1/org/membership") return { isAdmin: true };
    if (path.endsWith("/installations")) return [INSTALLATION];
    if (path.includes("/repositories"))
      return { repos: ["acme/api", "acme/web"], truncated: false };
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
        onInstallNew={onInstallNew}
        onConnected={onConnected}
      />,
    ),
  );
  return { onConnected, onInstallNew };
};

afterEach(() => vi.clearAllMocks());

describe("GitHubAppConnectDialog", () => {
  it("lists the org's installations and where each comes from", async () => {
    renderDialog();
    expect(await screen.findByText("acme")).toBeTruthy();
    expect(screen.getByText(/Connected in another workspace/)).toBeTruthy();
    expect(screen.getByText("Install on another GitHub account")).toBeTruthy();
  });

  it("sends exactly the picked repositories", async () => {
    const user = userEvent.setup();
    const { onConnected } = renderDialog();
    await user.click(await screen.findByText("acme"));
    await user.click(await screen.findByText("web"));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/v1/apps/github-app/connections",
      { sourceConnectionId: "conn-src", repositories: ["acme/web"] },
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("conn-new"));
  });

  it("can't connect a selected-repositories pick with nothing ticked", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByText("acme"));
    await screen.findByText("web");
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("All repositories sends no list (the whole installation grant)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByText("acme"));
    await user.click(screen.getByRole("button", { name: "All repositories" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    expect(mocks.apiPost).toHaveBeenCalledWith(
      "/v1/apps/github-app/connections",
      { sourceConnectionId: "conn-src" },
    );
  });

  it("hands a new GitHub account to the install flow", async () => {
    const user = userEvent.setup();
    const { onInstallNew } = renderDialog();
    await user.click(
      await screen.findByText("Install on another GitHub account"),
    );
    expect(onInstallNew).toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});
