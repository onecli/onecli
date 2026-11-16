// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsModalProvider } from "@/lib/settings-modal/modal-context";
import { AppsTab } from "./apps-tab";

// The unit: the Connections grid's GitHub App "Connect" offers installations
// already connected in the org (same as the app's own page) before sending
// anyone to GitHub. Everything around it is stubbed to an empty workspace.
const hoisted = vi.hoisted(() => ({
  shared: [] as unknown[],
  openPopup: vi.fn(),
  push: vi.fn(),
  pathname: "/w/ws-1/connections",
  search: "q=GitHub%20App",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: hoisted.push, replace: vi.fn() }),
  usePathname: () => hoisted.pathname,
  useSearchParams: () => new URLSearchParams(hoisted.search),
}));
vi.mock("@/lib/connect-popup", () => ({ openConnectPopup: hoisted.openPopup }));
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: [], isPending: false }),
}));
vi.mock("@/hooks/use-app-config", () => ({
  useConfiguredProviders: () => ({ data: [], isPending: false }),
  useEnvDefaultProviders: () => ({ data: ["github-app"], isPending: false }),
}));
vi.mock("@/hooks/use-available-apps", () => ({
  useAvailableApps: () => ({ data: { restricted: false, providers: [] } }),
}));
vi.mock("@/hooks/use-instance", () => ({ useInstance: () => null }));
vi.mock("@/hooks/use-verified-connect-link-agent", () => ({
  useVerifiedConnectLinkAgent: () => undefined,
}));
vi.mock("./use-connect-param", () => ({ useConnectParam: () => {} }));
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-github-app-share", () => ({
  GITHUB_APP_PROVIDER: "github-app",
  useSharedGitHubInstallations: () => ({ data: hoisted.shared }),
}));
vi.mock("./github-app-connect-dialog", () => ({
  GitHubAppConnectDialog: ({ open }: { open: boolean }) =>
    open ? <div>Connect GitHub App dialog</div> : null,
}));

afterEach(() => {
  hoisted.shared = [];
  hoisted.pathname = "/w/ws-1/connections";
  hoisted.search = "q=GitHub%20App";
  vi.clearAllMocks();
});

const clickGitHubAppConnect = async () => {
  const user = userEvent.setup();
  render(<AppsTab />);
  const row = (await screen.findByText("GitHub App")).closest("div.group");
  const button = row?.querySelector("button");
  if (!button) throw new Error("no Connect button on the GitHub App row");
  await user.click(button);
};

describe("AppsTab GitHub App Connect", () => {
  it("offers the org's connected installations first", async () => {
    hoisted.shared = [{ sourceConnectionId: "c1" }];
    await clickGitHubAppConnect();
    expect(
      await screen.findByText("Connect GitHub App dialog"),
    ).toBeInTheDocument();
    expect(hoisted.openPopup).not.toHaveBeenCalled();
  });

  it("goes straight to GitHub when the org has none", async () => {
    await clickGitHubAppConnect();
    await waitFor(() => expect(hoisted.openPopup).toHaveBeenCalled());
    expect(hoisted.openPopup.mock.calls[0]?.[0]).toBe("github-app");
    expect(screen.queryByText("Connect GitHub App dialog")).toBeNull();
  });
});

describe("AppsTab app rows", () => {
  const clickRow = async (ui: React.ReactNode) => {
    const user = userEvent.setup();
    render(ui);
    const row = (await screen.findByText("GitHub App")).closest("div.group");
    if (!row) throw new Error("no GitHub App row");
    await user.click(row);
  };

  it("opens the app's page on a route page", async () => {
    await clickRow(<AppsTab />);
    expect(hoisted.push).toHaveBeenCalledWith(
      "/w/ws-1/connections/apps/github-app",
    );
  });

  it("opens the app's detail inside the Settings modal, and scopes an org connect to the modal's org", async () => {
    hoisted.pathname = "/w/ws-1/agents/ag-1/chat";
    hoisted.search = "settings=shared-apps&q=GitHub%20App";
    await clickRow(
      <SettingsModalProvider
        value={{
          page: "shared-apps",
          organizationId: "org-1",
          workspaceId: "ws-1",
        }}
      >
        <AppsTab
          pageScope="organization"
          basePath="/org/org-1/settings/global-connections"
        />
      </SettingsModalProvider>,
    );
    expect(hoisted.push).toHaveBeenCalledWith(
      "/w/ws-1/agents/ag-1/chat?settings=shared-apps&app=github-app",
    );

    const user = userEvent.setup();
    const row = screen.getByText("GitHub App").closest("div.group");
    const button = row?.querySelector("button");
    if (!button) throw new Error("no Connect button on the GitHub App row");
    await user.click(button);
    await waitFor(() => expect(hoisted.openPopup).toHaveBeenCalled());
    expect(hoisted.openPopup.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: "ws-1",
      orgId: "org-1",
    });
  });
});
