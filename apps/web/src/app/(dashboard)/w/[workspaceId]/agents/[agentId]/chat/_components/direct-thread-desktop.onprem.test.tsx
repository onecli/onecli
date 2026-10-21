// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ChatThread } from "./chat-thread";

// A self-host never shows the agent's hosted desktop, even where it serves
// previews: no dock over the thread, no "Open computer" on an ask, and the
// licensed desktop code is never loaded. The edition is read once, when
// @/lib/env loads, so it is cleared before anything imports it.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const loaded = vi.hoisted(() => ({ dock: false }));

vi.mock("@/ee/desktop/desktop-dock", () => {
  loaded.dock = true;
  return { DesktopDock: () => <div>Agent screen</div> };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "agent-1", name: "Agent" }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => ({ previews: {} }),
}));
vi.mock("@/hooks/use-create-then-attach-secret", () => ({
  useCreateThenAttachSecret: () => ({ onSaved: vi.fn() }),
}));
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({ SecretDialog: () => null }),
);
vi.mock("@/hooks/use-conversations", () => ({
  useDirectConversation: () => ({ data: { id: "conv-1" }, isError: false }),
  useSendMessage: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
  useAbortTurn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-attachments", () => ({
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-conversation-transcript", () => ({
  useConversationTranscript: () => ({
    turnsQuery: { data: { turns: [] }, error: null },
    turns: [],
    folded: new Map(),
    stream: { status: "streaming" },
    loading: false,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
  }),
}));
vi.mock("./chat-thread", () => ({
  ChatThread: ({
    onOpenComputer,
    computerHref,
  }: ComponentProps<typeof ChatThread>) => (
    <div data-testid="transcript">
      {(onOpenComputer || computerHref) && <button>Open computer</button>}
    </div>
  ),
}));

const { DirectThreadSection } = await import("./direct-thread-section");

describe("direct chat on a self-host", () => {
  it("has no agent desktop, even where previews are served", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DirectThreadSection />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("transcript")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open computer" })).toBeNull();
    expect(screen.queryByText("Agent screen")).toBeNull();
    expect(loaded.dock).toBe(false);
  });
});
