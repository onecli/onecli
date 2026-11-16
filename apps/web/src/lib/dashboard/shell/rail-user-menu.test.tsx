// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

/**
 * The rail's account menu asks for the viewer's org role (it decides the
 * Billing entry) only where the URL names an org, and only on editions that
 * bill. On the account's own page there is no org to ask about, and for a
 * viewer with no org at all the read would answer 401.
 */

const state = vi.hoisted(() => {
  const asked: boolean[] = [];
  return { pathname: "/w/ws1/agents/ag1/chat", billing: true, asked };
});

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { name: "Sam", email: "s@x" }, signOut: vi.fn() }),
}));
vi.mock("@/hooks/use-org", () => ({
  useOrgMembership: (enabled = true) => {
    state.asked.push(enabled);
    return { data: undefined };
  },
}));
vi.mock("@/lib/env", () => ({
  get CAPS() {
    return { billing: state.billing };
  },
}));
vi.mock("@/lib/settings-modal/use-settings-href", () => ({
  useSettingsHref: () => (page: string) => `?settings=${page}`,
}));

const { RailUserMenu } = await import("./rail-user-menu");

afterEach(() => {
  cleanup();
  state.asked.length = 0;
  state.billing = true;
});

const asks = (pathname: string): boolean | undefined => {
  state.pathname = pathname;
  render(<RailUserMenu />);
  return state.asked.at(-1);
};

describe("RailUserMenu", () => {
  // Opened with the keyboard: Radix menus open on Enter, not on a jsdom
  // click (which lacks the pointer events it listens for).
  const entries = async (pathname: string) => {
    state.pathname = pathname;
    render(<RailUserMenu />);
    const trigger = screen.getByRole("button", { name: "Account" });
    trigger.focus();
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    return Object.fromEntries(
      screen
        .getAllByRole("menuitem")
        .map((item) => [
          item.textContent?.trim() ?? "",
          item.getAttribute("href"),
        ]),
    );
  };

  it("opens Profile and API keys in the Settings modal over an org page", async () => {
    const menu = await entries("/w/ws1/agents/ag1/chat");
    expect(menu.Profile).toBe("?settings=profile");
    expect(menu["API keys"]).toBe("?settings=api-keys");
  });

  // The account's own page is in the shell only for a viewer with no org:
  // no modal to open, and no org for API keys.
  it("links Profile to the account page and drops API keys there", async () => {
    const menu = await entries("/account");
    expect(menu.Profile).toBe("/account");
    expect("API keys" in menu).toBe(false);
  });
  it("asks for the org role on a workspace or org URL", () => {
    expect(asks("/w/ws1/agents/ag1/chat")).toBe(true);
    cleanup();
    expect(asks("/org/o1/skills")).toBe(true);
  });

  it("never asks on the account's own page", () => {
    expect(asks("/account")).toBe(false);
  });

  it("never asks on an edition that does not bill", () => {
    state.billing = false;
    expect(asks("/w/ws1/agents/ag1/chat")).toBe(false);
  });
});
