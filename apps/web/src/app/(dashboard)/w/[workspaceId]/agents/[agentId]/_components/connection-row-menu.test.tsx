// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/api";
import { ConnectionRowMenu } from "./connection-row-menu";

/**
 * The agent row's ⋮ menu. Every row opens the app's page in the workspace's
 * Connections; workspace connections also Reconnect and Rename. Organization
 * connections are managed on the organization's page, so they only open the
 * app's page here. Turning on or off is the row's switch. A reconnect it
 * opened refreshes the grant views when the popup reports back.
 */

const mocks = vi.hoisted(() => ({
  openConnectPopup: vi.fn(),
  invalidateGrants: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/connections",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/connect-popup", () => ({
  openConnectPopup: mocks.openConnectPopup,
  connectPopupHeight: () => undefined,
}));
vi.mock("@/hooks/use-grants", () => ({
  useInvalidateGrants: () => mocks.invalidateGrants,
}));

const connection = (over: Partial<Connection> = {}): Connection => ({
  id: "conn-1",
  provider: "gmail",
  label: "work@example.com",
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-10-01T00:00:00Z",
  ...over,
});

const renderMenu = (props: { connection?: Connection; active?: boolean }) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionRowMenu
        connection={props.connection ?? connection()}
        active={props.active ?? true}
      />
    </QueryClientProvider>,
  );

const openMenu = async () =>
  userEvent.click(screen.getByRole("button", { name: /More actions for/ }));

afterEach(() => vi.clearAllMocks());

describe("ConnectionRowMenu", () => {
  it("offers Reconnect, Rename and Open in Connections on an active workspace row", async () => {
    renderMenu({});
    await openMenu();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Reconnect", "Rename", "Open in Connections"]);
  });

  it("opens the app's page in the workspace's Connections", async () => {
    renderMenu({ connection: connection({ provider: "salesforce" }) });
    await openMenu();
    expect(
      screen
        .getByRole("menuitem", { name: "Open in Connections" })
        .getAttribute("href"),
    ).toBe("/w/ws-1/connections/apps/salesforce");
  });

  it("an organization connection only opens the app's page here", async () => {
    renderMenu({ connection: connection({ scope: "organization" }) });
    await openMenu();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open in Connections"]);
  });

  it("no app page to open for a provider missing from the registry", async () => {
    renderMenu({ connection: connection({ provider: "retired-app" }) });
    await openMenu();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Rename"]);
  });

  it("no menu for an organization connection missing from the registry, but the slot stays", () => {
    const { container } = renderMenu({
      connection: connection({
        scope: "organization",
        provider: "retired-app",
      }),
    });
    expect(
      screen.queryByRole("button", { name: /More actions for/ }),
    ).toBeNull();
    // Keeps the row's switch in line with its neighbours'.
    const slot = container.querySelector("span[aria-hidden]");
    expect(slot?.className).toContain("size-7");
  });

  it("no Reconnect for an inactive row", async () => {
    renderMenu({ active: false });
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Reconnect/ })).toBeNull();
  });

  it("no Reconnect for an account managed on the provider's side", async () => {
    renderMenu({
      connection: connection({
        metadata: { manageUrl: "https://github.com/settings/installations/1" },
      }),
    });
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Reconnect/ })).toBeNull();
  });

  it("refreshes the grant views once the reconnect it opened reports back", async () => {
    mocks.openConnectPopup.mockReturnValue({});
    renderMenu({});
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /Reconnect/ }));
    expect(mocks.openConnectPopup).toHaveBeenCalledWith(
      "gmail",
      expect.objectContaining({ connectionId: "conn-1", workspaceId: "ws-1" }),
    );

    const post = (provider: string) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: window.location.origin,
            data: { type: "app-connected", provider },
          }),
        );
      });
    // Another provider's popup is not this reconnect.
    post("slack");
    expect(mocks.invalidateGrants).not.toHaveBeenCalled();
    post("gmail");
    expect(mocks.invalidateGrants).toHaveBeenCalledTimes(1);
    // Done: the listener is gone.
    post("gmail");
    expect(mocks.invalidateGrants).toHaveBeenCalledTimes(1);
  });

  it("a blocked popup listens for nothing", async () => {
    mocks.openConnectPopup.mockReturnValue(null);
    renderMenu({});
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /Reconnect/ }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "app-connected", provider: "gmail" },
        }),
      );
    });
    expect(mocks.invalidateGrants).not.toHaveBeenCalled();
  });
});
