// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { toast } from "sonner";
import { grants, instance } from "@/lib/api";
import type { Connection, InstanceInfo } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { ConnectAppPickerDialog } from "./connect-app-picker-dialog";
import { ChatSendContext } from "@/lib/chat/chat-send";

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
    instance: {
      ...actual.instance,
      get: vi.fn().mockResolvedValue({
        edition: "onprem",
        entitled: false,
        version: "test",
      } satisfies InstanceInfo),
    },
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

/** Seed the picker inputs before mount: connections, org app availability,
 * runtime entitlement and the agent detail (the popup's `agent_name`). */
const renderPicker = ({
  connections = [] as Connection[],
  availability = { restricted: false, providers: [] as string[] },
  onOpenChange = vi.fn(),
  onConnected = undefined as ((connectionId: string) => void) | undefined,
  open = true,
  // Present = rendered inside an agent chat (the empty search can hand the
  // app to the agent); absent = the Connections page.
  chatSend = undefined as ((message: string) => void) | undefined,
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData<InstanceInfo>(queryKeys.instance.all(), {
    edition: "onprem",
    entitled: false,
    version: "test",
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
    <QueryClientProvider client={queryClient}>
      {chatSend ? (
        <ChatSendContext value={chatSend}>{children}</ChatSendContext>
      ) : (
        children
      )}
    </QueryClientProvider>
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
    vi.mocked(instance.get).mockClear();
    vi.mocked(grants.setConnectionGrant).mockClear();
    vi.mocked(toast.error).mockClear();
    pushMock.mockClear();
  });

  it("shows only the headline and search: no consent paragraph", () => {
    renderPicker();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Connect an app");
    expect(dialog).not.toHaveTextContent(/Only this agent gets access/);
    expect(dialog).not.toHaveTextContent(/Connecting turns the account on/);
    expect(screen.getByText("Search for an app to connect.")).toHaveClass(
      "sr-only",
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
    // Seed before mount so no in-flight instance read can overwrite this
    // test's entitlement when it resolves. Keep the API mock as a tripwire.
    expect(instance.get).not.toHaveBeenCalled();
    expect(row).toHaveTextContent(/Connect your Slack/);
    await userEvent.click(row);
    expect(openSpy).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/w/ws-1/agents/agent-1/contacts");
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

  describe("a search with no match, in a chat, hands the app to the agent", () => {
    const search = async (text: string) =>
      userEvent.type(screen.getByRole("textbox"), text);

    it("offers 'Connect X as a custom connection' and sends the agent the request", async () => {
      const chatSend = vi.fn();
      const { onOpenChange } = renderPicker({ chatSend });
      await search("AcmeCRM");
      expect(screen.getByText("No apps found.")).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", {
          name: /Connect “AcmeCRM” as a custom connection/,
        }),
      );
      expect(chatSend).toHaveBeenCalledWith(
        "I want to connect AcmeCRM as a custom connection with an API key.",
      );
      // The dialog closes so the person sees the agent pick it up.
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("sends a clean, clipped name: invisible characters dropped, capped at a connection name's length", async () => {
      const chatSend = vi.fn();
      renderPicker({ chatSend });
      await userEvent.click(screen.getByRole("textbox"));
      // A zero-width space hidden in the name, and a pasted paragraph.
      await userEvent.paste(`  Acme\u200bCRM   ${"x".repeat(200)}`);
      const name = `AcmeCRM ${"x".repeat(72)}`;
      expect(name).toHaveLength(80);
      // What the button shows is exactly what is sent.
      await userEvent.click(
        screen.getByRole("button", { name: new RegExp(`“${name}”`) }),
      );
      expect(chatSend).toHaveBeenCalledWith(
        `I want to connect ${name} as a custom connection with an API key.`,
      );
    });

    it("is not offered when the search finds an app", async () => {
      renderPicker({ chatSend: vi.fn() });
      await search("Gmail");
      expect(screen.queryByText(/as a custom connection/)).toBeNull();
    });

    it("is not offered for a built-in app the org hides here: the platform refuses a custom one", async () => {
      // MUTATION-PROOF: decide on the visible (org-filtered) list and this
      // offers a custom GitHub the propose step then refuses.
      renderPicker({
        chatSend: vi.fn(),
        availability: { restricted: true, providers: ["gmail"] },
      });
      await search("GitHub");
      expect(screen.getByText("No apps found.")).toBeInTheDocument();
      expect(screen.queryByText(/as a custom connection/)).toBeNull();
    });

    it("is not offered outside a chat (the Connections page)", async () => {
      renderPicker();
      await search("AcmeCRM");
      expect(screen.getByText("No apps found.")).toBeInTheDocument();
      expect(screen.queryByText(/as a custom connection/)).toBeNull();
    });
  });
});
