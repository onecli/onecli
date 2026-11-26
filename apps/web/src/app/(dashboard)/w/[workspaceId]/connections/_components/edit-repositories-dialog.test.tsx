// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditRepositoriesDialog } from "./edit-repositories-dialog";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiGet: vi.fn(),
  apiPatch: mocks.apiPatch,
  apiPost: mocks.apiPost,
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REPOS_PATH = "/v1/apps/github-app/connections/conn-1/repository-refresh";

const MANAGE =
  "https://github.com/organizations/acme/settings/installations/111";

const renderDialog = (
  selected: string[] | null,
  manageUrl: string | null = MANAGE,
) => {
  let available = ["acme/api", "acme/web"];
  mocks.apiPost.mockImplementation(async (path: string) => {
    if (path === REPOS_PATH) return { available, truncated: false, selected };
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.apiPatch.mockResolvedValue({ id: "conn-1", repositories: null });
  const onOpenChange = vi.fn();
  render(
    (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EditRepositoriesDialog
          connectionId="conn-1"
          account="acme"
          manageUrl={manageUrl}
          pageScope="workspace"
          open
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>
    ) as ReactNode,
  );
  return {
    onOpenChange,
    addRepoOnGitHub: (repo: string) => {
      available = [...available, repo];
    },
  };
};

afterEach(() => vi.clearAllMocks());

describe("EditRepositoriesDialog", () => {
  it("matches saved pins case-insensitively using current GitHub names", async () => {
    const user = userEvent.setup();
    renderDialog(["ACME/WEB"]);
    expect(await screen.findByRole("checkbox", { name: "web" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /Remove ACME/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        "/v1/apps/github-app/connections/conn-1",
        { repositories: ["acme/web"] },
      ),
    );
  });
  it("keeps unavailable pins visible and requires explicit removal before saving", async () => {
    const user = userEvent.setup();
    renderDialog(["acme/web", "acme/removed"]);
    const remove = await screen.findByRole("button", {
      name: "Remove acme/removed",
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(remove);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        "/v1/apps/github-app/connections/conn-1",
        { repositories: ["acme/web"] },
      ),
    );
  });

  it("does not save stale data or retry after a failed refresh on return", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue({} as Window);
    renderDialog(["acme/web"]);
    await screen.findByRole("checkbox", { name: "web" });
    mocks.apiPost.mockRejectedValue(new Error("Refresh refused"));
    await user.click(
      screen.getAllByRole("button", { name: "Manage on GitHub" })[0]!,
    );
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("Refresh refused");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.apiPost).toHaveBeenCalledTimes(2);
    expect(mocks.apiPatch).not.toHaveBeenCalled();
  });
  it("opens on the connection's current pick and saves a new one", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(["acme/web"]);
    const web = await screen.findByRole("checkbox", { name: "web" });
    expect(web).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "api" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        "/v1/apps/github-app/connections/conn-1",
        { repositories: ["acme/web", "acme/api"] },
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("an unpinned connection opens on All repositories and saves null", async () => {
    const user = userEvent.setup();
    renderDialog(null);
    expect(
      await screen.findByText(/Every repository this installation covers/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        "/v1/apps/github-app/connections/conn-1",
        { repositories: null },
      ),
    );
  });

  it("has no manual Refresh button (the list reloads on its own)", async () => {
    renderDialog(["acme/web"]);
    await screen.findByRole("checkbox", { name: "web" });
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
  });

  it("a selected pick with nothing ticked can't be saved", async () => {
    const user = userEvent.setup();
    renderDialog(["acme/web"]);
    await user.click(await screen.findByRole("checkbox", { name: "web" }));
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Manage on GitHub opens the installation settings, and the list refreshes on return", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const { addRepoOnGitHub } = renderDialog(["acme/api"]);
    await screen.findByText("web");
    await user.click(
      screen.getAllByRole("button", { name: /Manage on GitHub/ })[0]!,
    );
    expect(open).toHaveBeenCalledWith(
      MANAGE,
      "github-installation-settings",
      expect.any(String),
    );
    addRepoOnGitHub("acme/new");
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("new")).toBeTruthy();
    open.mockRestore();
  });

  it("never offers a non-GitHub settings link", async () => {
    renderDialog(["acme/api"], "https://evil.example/settings");
    await screen.findByText("web");
    expect(screen.queryByText("Manage on GitHub")).toBeNull();
  });
});
