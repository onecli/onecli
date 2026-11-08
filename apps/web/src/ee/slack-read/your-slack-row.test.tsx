// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SlackReadConnection } from "./api";

/**
 * The Slack DM "Connect your Slack" card links to Contacts with
 * `?connect=slack`: arriving there starts the connect flow once, and the
 * param is dropped so a reload doesn't start it again. The consent flow
 * returns here with `?connected=slack-read`.
 */

const state = vi.hoisted(() => ({
  connection: undefined as SlackReadConnection | undefined,
  search: "",
}));
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  replace: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/w/ws/agents/a/contacts",
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toast, error: vi.fn() } }));

vi.mock("./hooks", () => ({
  useSlackReadConnection: () => ({
    data: state.connection,
    isPending: state.connection === undefined,
  }),
  useStartSlackConnect: () => ({ mutate: mocks.start, isPending: false }),
  useDisconnectSlack: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { YourSlackRow } = await import("./your-slack-row");

const client = new QueryClient();
const wrap = (ui: ReactElement) => (
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>
);
const row = () => wrap(<YourSlackRow agentId="a" agentName="Helper" />);

const notConnected = {
  connected: false,
  available: true,
  canWrite: false,
  profile: null,
} as unknown as SlackReadConnection;

describe("YourSlackRow ?connect=slack", () => {
  beforeEach(() => {
    mocks.start.mockReset();
    mocks.replace.mockReset();
    mocks.toast.mockReset();
    state.connection = notConnected;
    state.search = "";
  });

  it("starts the connect flow once and drops the param", () => {
    state.search = "connect=slack&tab=x";
    const { rerender } = render(row());
    rerender(row());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith("/w/ws/agents/a/contacts?tab=x");
  });

  it("does nothing without the param", () => {
    render(row());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(screen.getByText("Connect your Slack")).toBeTruthy();
  });

  it("already connected with writing: drops the param, starts nothing", () => {
    state.search = "connect=slack";
    state.connection = {
      ...notConnected,
      connected: true,
      canWrite: true,
    } as SlackReadConnection;
    render(row());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/w/ws/agents/a/contacts");
  });

  it("a same-tab return (`?connected=slack-read`) says so once and drops the param", () => {
    state.search = "connected=slack-read";
    const { rerender } = render(row());
    rerender(row());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("Your Slack is connected");
    expect(mocks.replace).toHaveBeenCalledWith("/w/ws/agents/a/contacts", {
      scroll: false,
    });
  });
});
