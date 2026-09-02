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
  onGranted = undefined as ((connectionId: string) => void) | undefined,
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
      onGranted={onGranted}
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

  it("honors the org app-availability restriction — only allowed providers listed", () => {
    renderPicker({ availability: { restricted: true, providers: ["gmail"] } });
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.queryByText("Slack")).toBeNull();
  });

  it("lists the whole catalog when the org is open (restricted:false)", () => {
    renderPicker();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("opens the shared popup with agent name, workspace, and dedupe window name", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, windowName] = openSpy.mock.calls[0] ?? [];
    expect(url).toContain("/app-connect/gmail?");
    expect(url).toContain("agent_name=Arik");
    expect(url).toContain("workspaceId=ws-1");
    expect(windowName).toBe("connect-gmail-new");
  });

  it("uses the taller popup for credentials-import apps", async () => {
    renderPicker();
    await userEvent.click(screen.getByRole("button", { name: /^Docker Hub/ }));
    const [, , features] = openSpy.mock.calls[0] ?? [];
    expect(features).toContain("height=820");
  });

  it("auto-grants full access ONLY for a connect this dialog initiated", async () => {
    const onGranted = vi.fn();
    renderPicker({ onGranted });

    // A popup someone else opened reports a new connection: no grant.
    postAppMessage({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();

    // Initiated here → the same message grants and reports back.
    await userEvent.click(screen.getByRole("button", { name: /^Gmail/ }));
    postAppMessage({
      type: "app-connected",
      provider: "gmail",
      connectionId: "conn-9",
    });
    await waitFor(() =>
      expect(grants.setConnectionGrant).toHaveBeenCalledWith(
        "agent-1",
        "conn-9",
        { access: "full" },
      ),
    );
    await waitFor(() => expect(onGranted).toHaveBeenCalledWith("conn-9"));
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
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining("/connections/apps/gmail"),
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
    expect(screen.queryByText("Slack")).toBeNull();

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
