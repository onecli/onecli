// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { toast } from "sonner";
import { grants } from "@/lib/api";
import type { Connection } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { ConnectAppPickerDialog } from "./connect-app-picker-dialog";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1",
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      setConnectionGrant: vi.fn().mockResolvedValue({}),
    },
  };
});

const connectedGmail: Connection = {
  id: "conn-1",
  provider: "gmail",
  label: null,
  status: "connected",
  scopes: [],
  scope: "workspace",
  metadata: null,
  connectedAt: "2026-08-01T00:00:00Z",
};

/** Seeded client so the dialog's data graph never hits the network:
 * connections pool, org app availability, and the agent's detail (the
 * popup's `agent_name`). */
const renderPicker = ({
  connections = [] as Connection[],
  availability = { restricted: false, providers: [] as string[] },
  onOpenChange = vi.fn(),
  onConnected = undefined as ((connectionId: string) => void) | undefined,
  open = true,
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    queryKeys.connections.list("workspace"),
    connections,
  );
  queryClient.setQueryData(queryKeys.appAvailability.available(), availability);
  queryClient.setQueryData(queryKeys.agents.detail("agent-1"), {
    id: "agent-1",
    name: "Arik",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = render(
    <ConnectAppPickerDialog
      agentId="agent-1"
      open={open}
      onOpenChange={onOpenChange}
      onConnected={onConnected}
    />,
    { wrapper },
  );
  return { ...view, queryClient, onOpenChange, wrapper };
};

const postAppMessage = (data: Record<string, unknown>) => {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { origin: window.location.origin, data }),
    );
  });
};

describe("ConnectAppPickerDialog", () => {
  let openSpy: MockInstance<typeof window.open>;

  beforeEach(() => {
    // A truthy handle: the blocked-popup branch is exercised explicitly below.
    openSpy = vi.spyOn(window, "open").mockReturnValue({} as unknown as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(grants.setConnectionGrant).mockClear();
    vi.mocked(toast.error).mockClear();
    pushMock.mockClear();
  });

  it("states what a new account gets: the default attach, never full access for a catalogued app", () => {
    renderPicker();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Connecting turns the account on for this agent, not for your other agents. Reads are allowed. Writes and anything else need your approval (an app with no tool list gets full access).",
    );
  });

  it("honors the org app-availability restriction — only allowed providers listed", () => {
    renderPicker({ availability: { restricted: true, providers: ["gmail"] } });
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("lists the whole catalog when the org is open (restricted:false)", () => {
    renderPicker();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("never offers Slack as a gateway connection — it is a channel (the agent's own app)", () => {
    // plans/channel-aware-agents.md: the Slack gateway app was removed so
    // the agent stops reaching for slack.com through the proxy. The picker
    // reads the real registry, so this pins the removal end to end. With no
    // entitlement there is no Slack row at all.
    renderPicker();
    expect(screen.queryByText("Slack")).toBeNull();
  });

  it("entitled: Slack is a door to this agent's Slack page (read access), never a connect popup", async () => {
    const { queryClient } = renderPicker();
    act(() => {
      queryClient.setQueryData(queryKeys.instance.all(), { entitled: true });
      queryClient.setQueryData(queryKeys.agents.detail("agent-1"), {
        id: "agent-1",
        name: "Arik",
        channels: [{ provider: "slack", status: "active" }],
      });
    });
    await userEvent.type(screen.getByLabelText("Search apps"), "sla");
    const row = await screen.findByRole("button", { name: /^Slack/ });
    expect(row).toHaveTextContent(/Connect your Slack/);
    await userEvent.click(row);
    expect(openSpy).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/w/ws-1/agents/agent-1/channels");
  });

  it("opens the shared popup with agent name, workspace, and dedupe window name", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, windowName] = openSpy.mock.calls[0] ?? [];
    expect(url).toContain("/app-connect/gmail?");
    expect(url).toContain("agent_name=Arik");
    // The connect carries THIS agent: the new account lands on for it alone.
    expect(url).toContain("agent_id=agent-1");
    expect(url).toContain("workspaceId=ws-1");
    expect(windowName).toBe("connect-gmail-new");
  });

  it("uses the taller popup for credentials-import apps", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /^Docker Hub/ }));
    const [, , features] = openSpy.mock.calls[0] ?? [];
    expect(features).toContain("height=820");
  });

  it("hands a connect this dialog initiated to onConnected, and writes no grant", async () => {
    // The API's connecting-agent grant already turned the new account on for
    // this agent, so a client grant would be a second, redundant write (and a
    // second audit row).
    const onConnected = vi.fn();
    const { queryClient } = renderPicker({ onConnected });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // A popup someone else opened reports a new connection: ignored.
    postAppMessage({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await act(async () => {});
    expect(onConnected).not.toHaveBeenCalled();

    // Initiated here → the same message lands: the grant views refresh so the
    // new account shows attached, and the caller gets the fresh id.
    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    postAppMessage({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("conn-9"));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.grants.all(),
    });
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("refreshes connections + counts even when the popup lands without a connectionId", async () => {
    const { queryClient, onOpenChange } = renderPicker();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    // Reconnect/dedupe path: connected, but no fresh connection id.
    postAppMessage({ type: "app-connected", provider: "gmail" });
    await act(async () => {});

    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.connections.all(),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.counts.all(),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("routes an unconfigured app to its config page — fenced to its own popups", async () => {
    renderPicker();

    // Not initiated here: the message belongs to another door.
    postAppMessage({ type: "app-configure", provider: "gmail" });
    await act(async () => {});
    expect(pushMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    postAppMessage({ type: "app-configure", provider: "gmail" });
    await act(async () => {});
    // The setup page gets this agent, so the connect after it is its own.
    expect(pushMock).toHaveBeenCalledWith(
      "/w/ws-1/connections/apps/gmail?source=agent&agent_id=agent-1",
    );

    // The claim was consumed: a replay must not navigate again.
    postAppMessage({ type: "app-configure", provider: "gmail" });
    await act(async () => {});
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("releases the claim and explains when the popup is blocked", async () => {
    openSpy.mockReturnValue(null);
    renderPicker();

    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    expect(toast.error).toHaveBeenCalledWith(
      "Popup blocked. Allow popups for this site and try again.",
    );

    // The released claim must not adopt a later connect from another door.
    postAppMessage({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("starts each open fresh — the previous search does not leak", async () => {
    const { rerender } = renderPicker();
    const input = screen.getByLabelText("Search apps");
    await userEvent.type(input, "hub");
    expect(input).toHaveValue("hub");

    rerender(
      <ConnectAppPickerDialog
        agentId="agent-1"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    rerender(
      <ConnectAppPickerDialog
        agentId="agent-1"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Search apps")).toHaveValue("");
  });

  it("filters the catalog by the search query", async () => {
    renderPicker();
    await userEvent.type(screen.getByLabelText("Search apps"), "gmail");
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).toBeNull();

    await userEvent.clear(screen.getByLabelText("Search apps"));
    await userEvent.type(screen.getByLabelText("Search apps"), "zzz-no-app");
    expect(screen.getByText("No apps found.")).toBeInTheDocument();
  });

  it("marks connected providers and offers connecting another account", () => {
    renderPicker({
      connections: [connectedGmail, { ...connectedGmail, id: "conn-2" }],
    });
    expect(screen.getByText("2 connected")).toBeInTheDocument();
    expect(
      screen.getByTitle("Connect another Gmail account"),
    ).toBeInTheDocument();
  });
});
