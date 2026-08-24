// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { grants } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { AttachParamDialog } from "./attach-param-dialog";

// Mutable so each test can shape the deep link.
let attachParam: string | null = null;
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () =>
    new URLSearchParams(attachParam ? { attach: attachParam } : {}),
}));

// Unit boundary — same as the card suite: the manage sheet brings its own
// data graph.
vi.mock("../../_components/manage-permissions-dialog", () => ({
  ManagePermissionsDialog: () => null,
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

/** Seeded client: an empty pool — the deep-link door's dominant landing. */
const renderDoor = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.connections.list("workspace"), []);
  queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
    agentId: "agent-1",
    mode: "grants",
    connections: [],
    secrets: [],
  });
  queryClient.setQueryData(
    [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
    { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<AttachParamDialog />, { wrapper });
};

describe("AttachParamDialog (?attach= deep link)", () => {
  let openSpy: MockInstance<typeof window.open>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockReturnValue({} as unknown as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(grants.setConnectionGrant).mockClear();
    pushMock.mockClear();
    attachParam = null;
    window.history.replaceState(null, "", "/w/ws-1/agents/agent-1/chat");
  });

  it("opens the attach dialog for a catalog provider", () => {
    attachParam = "gmail";
    renderDoor();
    expect(screen.getByRole("dialog")).toHaveTextContent("Attach Gmail");
    expect(
      screen.getByText("No connected Gmail accounts in this workspace yet."),
    ).toBeInTheDocument();
  });

  it("renders nothing for a provider the app catalog does not know", () => {
    // MUTATION-PROOF: drop the getApp gate and a crafted ?attach=totally-fake
    // renders an official-looking first-party dialog for a non-app — the
    // same law the web card (isCardConnectLink) and the adapter enforce.
    attachParam = "totally-fake";
    renderDoor();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing for a malformed provider id", () => {
    attachParam = "GMAIL!";
    renderDoor();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("consumes the param shallowly on close and stays closed", async () => {
    attachParam = "gmail";
    window.history.replaceState(
      null,
      "",
      "/w/ws-1/agents/agent-1/chat?attach=gmail&tab=chat",
    );
    renderDoor();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    // The dialog closes even while the (mocked, non-syncing) searchParams
    // still carry the param — the closedFor guard, not router timing.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The strip is shallow and preserves the other params.
    expect(window.location.search).toBe("?tab=chat");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("auto-grants ONLY a connect this door initiated — keyed by provider, surviving the dialog's close", async () => {
    attachParam = "gmail";
    renderDoor();

    // An event nobody here claimed: no grant.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();

    // Claim it, close the dialog mid-flight, then the popup lands: the
    // grant the Slack button promised must still happen.
    await userEvent.click(
      screen.getByRole("button", { name: "Connect an account" }),
    );
    expect(openSpy).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(grants.setConnectionGrant).toHaveBeenCalledWith(
        "agent-1",
        "conn-9",
        { access: "full" },
      ),
    );
    expect(grants.setConnectionGrant).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the popup is blocked", async () => {
    openSpy.mockReturnValue(null);
    attachParam = "gmail";
    renderDoor();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect an account" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "gmail",
            connectionId: "conn-9",
          },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });

  it("a different provider's landing never consumes this door's claim", async () => {
    attachParam = "gmail";
    renderDoor();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect an account" }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "app-connected",
            provider: "slack",
            connectionId: "conn-3",
          },
        }),
      );
    });
    await act(async () => {});
    expect(grants.setConnectionGrant).not.toHaveBeenCalled();
  });
});
