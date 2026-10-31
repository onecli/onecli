// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectGitHubAppButton } from "./connect-github-app-button";

const popup = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());

vi.mock("@/lib/connect-popup", () => ({ openConnectPopup: popup }));
vi.mock("@/hooks/use-app-config", () => ({
  useSaveAppConfig: () => ({ isPending: false, mutateAsync: saveConfig }),
}));

const renderButton = () => {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ConnectGitHubAppButton orgId="org-1" />
    </QueryClientProvider>,
  );
  return spy;
};

const postFromPopup = (data: Record<string, unknown>) =>
  act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { origin: window.location.origin, data }),
    );
  });

beforeEach(() => {
  popup.mockReset();
  saveConfig.mockReset();
});

describe("ConnectGitHubAppButton", () => {
  it("opens the org-level connect popup: the server decides whether setup is needed", async () => {
    renderButton();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect GitHub App" }),
    );
    expect(popup).toHaveBeenCalledWith("github-app", { orgId: "org-1" });
    expect(screen.queryByText("App ID")).toBeNull();
  });

  it("the popup asking for setup opens the GitHub App setup dialog here", async () => {
    renderButton();
    await postFromPopup({ type: "app-configure", provider: "github-app" });
    expect(await screen.findByText("App ID")).toBeDefined();
  });

  it("another app's setup request is not this dialog's", async () => {
    renderButton();
    await postFromPopup({ type: "app-configure", provider: "gmail" });
    expect(screen.queryByText("App ID")).toBeNull();
  });

  it("a finished connection refreshes the library's GitHub accounts", async () => {
    const spy = renderButton();
    await postFromPopup({ type: "app-connected", provider: "github-app" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining(["github-accounts"]),
      }),
    );
  });
});
