// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReadGrant, SlackReadConnection } from "./api";

const state = vi.hoisted(() => ({
  connection: undefined as SlackReadConnection | undefined,
  grants: [] as ReadGrant[],
}));

vi.mock("./hooks", () => ({
  useSlackReadConnection: () => ({ data: state.connection }),
  useSlackReadGrants: () => ({ data: { grants: state.grants } }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/connections",
}));

const { SlackReadConnectionRow } = await import("./slack-read-connection-row");

const grant = (over: Partial<ReadGrant>): ReadGrant => ({
  id: "g",
  subjectKind: "channel",
  externalRef: "C0X",
  subjectLabel: "#x",
  audience: "granter_only",
  grantedBy: { id: "u", name: null, email: "u@example.com" },
  mine: true,
  ...over,
});

describe("SlackReadConnectionRow", () => {
  beforeEach(() => {
    state.connection = undefined;
    state.grants = [];
  });

  it("renders nothing until the caller has connected", () => {
    state.connection = { connected: false, available: true, profile: null };
    const { container } = render(<SlackReadConnectionRow agentId="ag-1" />);
    expect(container.textContent).toBe("");
  });

  it("connected: a locked-on line with your account, your share count, and Manage to the Slack page", () => {
    state.connection = {
      connected: true,
      available: true,
      profile: {
        handle: "riley",
        realName: "Riley Chen",
        email: "riley@example.com",
        avatarUrl: null,
      },
    };
    state.grants = [
      grant({ id: "a" }),
      grant({ id: "b", externalRef: "C0Y" }),
      // Someone else's share is not "yours" on this line.
      grant({ id: "c", externalRef: "C0Z", mine: false }),
    ];
    render(<SlackReadConnectionRow agentId="ag-1" />);
    expect(screen.getByText("riley@example.com")).toBeTruthy();
    expect(screen.getByText(/read only · 2 shared/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Manage/ }).getAttribute("href"),
    ).toBe("/w/ws-1/agents/ag-1/channels");
    const toggle = screen.getByRole("switch", {
      name: /Slack read access is on/,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });
});
