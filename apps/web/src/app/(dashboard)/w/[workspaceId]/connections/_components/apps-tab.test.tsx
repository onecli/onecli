// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppsTab } from "./apps-tab";

// The unit: the Connections grid's GitHub App "Connect" offers installations
// already connected in the org (same as the app's own page) before sending
// anyone to GitHub. Everything around it is stubbed to an empty workspace.
const hoisted = vi.hoisted(() => ({
  shared: [] as unknown[],
  openPopup: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/ws-1/connections",
  useSearchParams: () => new URLSearchParams("q=GitHub%20App"),
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
