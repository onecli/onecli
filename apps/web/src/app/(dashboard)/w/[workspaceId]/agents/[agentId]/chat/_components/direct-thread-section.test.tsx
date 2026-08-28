// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { conversations, grants, secrets } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { Turn } from "@/lib/api";
import type { SecretActions } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/types";
import { DirectThreadSection } from "./direct-thread-section";

// The unit here is the in-place key door: notice → dialog → create → attach
// → auto-resend of the failed message. The heavy children are stubbed to
// their contracts (the SecretDialog stub replays the real await/onSaved
// shape); the React Query hooks run for real over a mocked @/lib/api, so the
// resend's fresh-cache read exercises the same keys the section writes.
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  // Real-router behavior for the greeting seam: params reflect the current
  // URL at render time (jsdom keeps window.location in sync with the
  // history calls the tests and the section itself make).
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "agent-1", name: "Agent" }),
}));

vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
}));

vi.mock("@/hooks/use-conversation-stream", () => ({
  useConversationStream: () => ({
    events: [],
    status: "streaming",
    error: undefined,
  }),
}));

vi.mock("./chat-thread", () => ({
  ChatThread: ({ onConnectModelKey }: { onConnectModelKey?: () => void }) => (
    <button data-testid="connect-key" onClick={() => onConnectModelKey?.()}>
      connect key
    </button>
  ),
}));

// The composer stub surfaces the one prop this section computes for it —
// `initialDraft` — so the greeting seam (URL flag → draft text) is testable
// without the real textarea (whose own behavior composer.test.tsx covers).
vi.mock("./composer", () => ({
  Composer: ({ initialDraft }: { initialDraft?: string }) => (
    <div data-testid="composer" data-initial-draft={initialDraft ?? ""} />
  ),
}));
vi.mock("./offline-banner", () => ({ OfflineBanner: () => null }));

vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: ({
      open,
      onSaved,
      secretActions,
    }: {
      open: boolean;
      onSaved?: () => void;
      secretActions?: Partial<SecretActions>;
    }) =>
      open ? (
        <button
          data-testid="save-secret"
          onClick={() => {
            void secretActions
              ?.createSecret?.({ name: "n", type: "anthropic" } as never)
              .then(() => onSaved?.())
              .catch(() => {
                /* the real dialog toasts and does NOT call onSaved */
              });
          }}
        >
          save
        </button>
      ) : null,
  }),
);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    conversations: {
      ...actual.conversations,
      ensureDirect: vi.fn(),
      turns: vi.fn(),
      sendMessage: vi.fn(),
    },
    grants: { ...actual.grants, attachSecret: vi.fn() },
    secrets: { ...actual.secrets, create: vi.fn() },
  };
});

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "t1",
  conversationId: "conv-1",
  status: "failed",
  source: "web",
  userId: "u1",
  message: "the ask",
  error: "This agent doesn't have a model key yet.",
  errorCode: "no_model_key",
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  ...overrides,
});

const renderSection = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...render(<DirectThreadSection />, { wrapper }), queryClient };
};

const openDoorAndSave = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("connect-key")).toBeInTheDocument(),
  );
  await userEvent.click(screen.getByTestId("connect-key"));
  await userEvent.click(screen.getByTestId("save-secret"));
};

describe("the chat's in-place model-key door", () => {
  afterEach(() => {
    vi.mocked(conversations.ensureDirect).mockReset();
    vi.mocked(conversations.turns).mockReset();
    vi.mocked(conversations.sendMessage).mockReset();
    vi.mocked(grants.attachSecret).mockReset();
    vi.mocked(secrets.create).mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  const arrange = (turns: Turn[]) => {
    vi.mocked(conversations.ensureDirect).mockResolvedValue({
      id: "conv-1",
    } as never);
    vi.mocked(conversations.turns).mockResolvedValue(turns);
    vi.mocked(secrets.create).mockResolvedValue({ id: "sec-9" } as never);
    vi.mocked(grants.attachSecret).mockResolvedValue({} as never);
    vi.mocked(conversations.sendMessage).mockResolvedValue({
      kind: "turn",
      turn: turn({ id: "t2", status: "queued", errorCode: null, error: null }),
    } as never);
  };

  it("saves the key, attaches it to THIS agent, then re-sends the failed message by itself", async () => {
    arrange([turn()]);
    renderSection();

    await openDoorAndSave();

    await waitFor(() =>
      expect(grants.attachSecret).toHaveBeenCalledWith("agent-1", "sec-9"),
    );
    // The wow moment: the agent answers the thing the user already asked —
    // exactly the failed turn's words, nothing else.
    await waitFor(() =>
      expect(conversations.sendMessage).toHaveBeenCalledWith(
        "conv-1",
        "the ask",
        undefined,
      ),
    );
    expect(conversations.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never re-sends when the attach failed — the key isn't on the agent yet", async () => {
    arrange([turn()]);
    vi.mocked(grants.attachSecret).mockRejectedValue(new Error("nope"));
    renderSection();

    await openDoorAndSave();

    await waitFor(() => expect(grants.attachSecret).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });

  it("never attaches (or re-sends) when the create failed", async () => {
    arrange([turn()]);
    vi.mocked(secrets.create).mockRejectedValue(new Error("nope"));
    renderSection();

    await openDoorAndSave();

    await new Promise((r) => setTimeout(r, 0));
    expect(grants.attachSecret).not.toHaveBeenCalled();
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves a turn that carried files alone — bound attachments can never ride a resend", async () => {
    arrange([
      turn({
        attachments: [
          {
            id: "att-1",
            name: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
            status: "bound",
          },
        ],
      }),
    ]);
    renderSection();

    await openDoorAndSave();

    await waitFor(() => expect(grants.attachSecret).toHaveBeenCalled());
    // The silence would read as failure: the attach worked and the manual
    // step (files can't ride a resend) is named.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Model key connected. Re-send your message to include its files.",
      ),
    );
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });

  it("reads the turns FRESH at attach time — a run that started mid-attach blocks the resend", async () => {
    // Pins the fresh-cache read: a mutant that reverts to the render-time
    // closure would miss the turn that appeared while the attach was in
    // flight, and double-send.
    arrange([turn()]);
    let resolveAttach!: (value: unknown) => void;
    vi.mocked(grants.attachSecret).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve;
        }) as never,
    );
    const { queryClient } = renderSection();

    await openDoorAndSave();
    await waitFor(() => expect(grants.attachSecret).toHaveBeenCalled());

    queryClient.setQueryData(queryKeys.conversations.turns("conv-1"), [
      turn(),
      turn({ id: "t-active", status: "running", errorCode: null, error: null }),
    ]);
    resolveAttach({});

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Model key connected."),
    );
    expect(conversations.sendMessage).not.toHaveBeenCalled();
  });
});

describe("the onboarding greeting hand-off (?hello=1)", () => {
  afterEach(() => {
    vi.mocked(conversations.ensureDirect).mockReset();
    vi.mocked(conversations.turns).mockReset();
    window.history.replaceState(null, "", "/w/ws-1/agents/agent-1/chat");
  });

  const arrange = () => {
    vi.mocked(conversations.ensureDirect).mockResolvedValue({
      id: "conv-1",
    } as never);
    vi.mocked(conversations.turns).mockResolvedValue([]);
  };

  it("hands the composer the greeting draft and strips the flag from the URL", async () => {
    arrange();
    window.history.replaceState(
      null,
      "",
      "/w/ws-1/agents/agent-1/chat?hello=1",
    );
    renderSection();

    await waitFor(() =>
      expect(screen.getByTestId("composer")).toHaveAttribute(
        "data-initial-draft",
        "Hey Agent, what can you do for me?",
      ),
    );
    // Consumed: the flag is gone, so a refresh opens a plain empty chat.
    expect(window.location.search).toBe("");
  });

  it("stripping the flag leaves the URL's other params alone", async () => {
    arrange();
    window.history.replaceState(
      null,
      "",
      "/w/ws-1/agents/agent-1/chat?attach=slack&hello=1",
    );
    renderSection();

    await waitFor(() => expect(window.location.search).toBe("?attach=slack"));
  });

  it("opens empty without the flag — every non-onboarding route is untouched", async () => {
    arrange();
    renderSection();

    await waitFor(() =>
      expect(screen.getByTestId("composer")).toHaveAttribute(
        "data-initial-draft",
        "",
      ),
    );
  });
});
