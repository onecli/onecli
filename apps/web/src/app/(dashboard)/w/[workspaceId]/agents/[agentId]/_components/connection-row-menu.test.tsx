// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/api";
import { ConnectionRowMenu } from "./connection-row-menu";

/**
 * The agent row's ⋮ menu. Workspace connections: Reconnect, Rename and
 * Turn on/off. Organization connections are managed on the organization's
 * page, so here they only turn on or off. A reconnect it opened refreshes
 * the grant views when the popup reports back.
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

const renderMenu = (props: {
  connection?: Connection;
  active?: boolean;
  toggleDisabled?: boolean;
}) => {
  const onToggle = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionRowMenu
        connection={props.connection ?? connection()}
        active={props.active ?? true}
        toggleDisabled={props.toggleDisabled ?? false}
        onToggle={onToggle}
      />
    </QueryClientProvider>,
  );
  return { onToggle };
};

const openMenu = async () =>
  userEvent.click(screen.getByRole("button", { name: /More actions for/ }));

afterEach(() => vi.clearAllMocks());

describe("ConnectionRowMenu", () => {
  it("offers Reconnect, Rename and Turn off on an active workspace row", async () => {
    const { onToggle } = renderMenu({});
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /Reconnect/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Turn off for this agent/ }),
    );
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("an organization connection only turns on or off here", async () => {
    const { onToggle } = renderMenu({
      connection: connection({ scope: "organization" }),
      active: false,
    });
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /Reconnect/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Turn on for this agent/ }),
    );
    expect(onToggle).toHaveBeenCalledWith(true);
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
