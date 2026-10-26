// @vitest-environment jsdom
import {
  Activity,
  Suspense,
  use,
  useEffect,
  type ComponentProps,
  type ReactNode,
} from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@/lib/api";
import type { DesktopState } from "@/ee/desktop/api";
import type { ChatThread } from "./chat-thread";
import type { DesktopScreen } from "@/ee/desktop/desktop-screen";

// The hosted desktop exists on the hosted platform only (IS_CLOUD is read
// once, when @/lib/env loads).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const spies = vi.hoisted(() => ({
  transcriptMount: vi.fn(),
  transcriptUnmount: vi.fn(),
  threadMount: vi.fn(),
  threadUnmount: vi.fn(),
  send: vi.fn(),
  upload: vi.fn<(file: File) => Promise<AttachmentMeta>>(),
  previews: true,
}));

// The dock's code arrives later than the chat's, the way a lazy chunk does in
// a browser. Open by default, and a test closes it to hold the first load.
const dockChunk = vi.hoisted(() => ({
  arrived: Promise.resolve(),
}));

// What `app/` code gets from `next/dynamic` (Next aliases it to
// `next/dist/api/app-dynamic`): a bare React.lazy that suspends to the
// nearest boundary. The package root is the pages-router loader, which never
// suspends, so a test on it cannot see what the browser does.
vi.mock("next/dynamic", async () => ({
  default: (await import("next/dist/api/app-dynamic")).default,
}));
vi.mock("@/ee/desktop/desktop-dock", async (importOriginal) => {
  await dockChunk.arrived;
  return importOriginal();
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
  useInstance: () => ({ previews: spies.previews ? {} : undefined }),
}));
vi.mock("@/hooks/use-create-then-attach-secret", () => ({
  useCreateThenAttachSecret: () => ({ onSaved: vi.fn() }),
}));
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: () => null,
  }),
);
vi.mock("@/hooks/use-conversations", () => ({
  useDirectConversation: () => ({ data: { id: "conv-1" }, isError: false }),
  useSendMessage: () => ({
    mutate: spies.send,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  }),
  useAbortTurn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-attachments", () => ({
  useUploadAttachment: () => ({ mutateAsync: spies.upload }),
}));
vi.mock("@/hooks/use-conversation-transcript", () => ({
  // Count hook lifetimes, not renders. A second theater reader must fail this.
  useConversationTranscript: () => {
    useEffect(() => {
      spies.transcriptMount();
      return () => {
        spies.transcriptUnmount();
      };
    }, []);
    return {
      turnsQuery: { data: { turns: [] }, error: null },
      turns: [],
      folded: new Map(),
      stream: { status: "streaming" },
      loading: false,
      hasOlder: false,
      loadingOlder: false,
      loadOlder: vi.fn(),
    };
  },
}));
vi.mock("./chat-thread", () => ({
  ChatThread: ({ onOpenComputer }: ComponentProps<typeof ChatThread>) => {
    useEffect(() => {
      spies.threadMount();
      return () => {
        spies.threadUnmount();
      };
    }, []);
    return (
      <div data-testid="transcript">
        The conversation
        {onOpenComputer && (
          <button onClick={() => onOpenComputer("req-1")}>Open computer</button>
        )}
      </div>
    );
  },
}));
// Keep the actual dock, overlay, preferences, theater, control pill and composer.
// Only the remote screen and network hooks are replaced.
vi.mock("@/ee/desktop/desktop-screen", () => ({
  DesktopScreen: ({ children }: ComponentProps<typeof DesktopScreen>) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/ee/desktop/use-desktop", () => ({
  useDesktop: () => ({
    data: {
      available: true,
      sandboxState: "awake",
      viewHost: "desktop.example.test",
      controlHost: null,
      controller: null,
      request: null,
      you: { controlling: false },
    } satisfies DesktopState,
  }),
  useTakeControl: () => ({ mutate: vi.fn(), isPending: false }),
  useReleaseControl: () => ({ mutate: vi.fn(), isPending: false }),
  useWakeDesktop: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { DirectThreadSection } = await import("./direct-thread-section");

beforeEach(() => {
  vi.clearAllMocks();
  spies.previews = true;
  dockChunk.arrived = Promise.resolve();
  localStorage.clear();
  // These walk the theater from the open card, which the person chose once
  // (the dock starts minimized to the header chip otherwise).
  localStorage.setItem(
    "onecli:desktop-dock:agent-1",
    JSON.stringify({ mode: "card", chat: false, corner: "bottom-right" }),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  spies.upload.mockResolvedValue({
    id: "attachment-1",
    status: "pending",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DirectThreadSection />
    </QueryClientProvider>,
  );
};

const ROUTE_LOADING = "Loading the agent section";

/** The section under its route's `loading.tsx` boundary, as Next mounts it. */
const routeTree = (client: QueryClient, children: ReactNode) => (
  <QueryClientProvider client={client}>
    <Suspense fallback={<p>{ROUTE_LOADING}</p>}>{children}</Suspense>
  </QueryClientProvider>
);

/** The siblings of the chat's container (the nearest element holding both
 *  the transcript and the composer). Its slot shares the height between
 *  every flexible child, so any sibling, even an empty one, halves the chat. */
const chatContainerSiblings = () => {
  const composer = screen.getByRole("textbox", { name: "Message" });
  let container = screen.getByTestId("transcript").parentElement;
  while (container && !container.contains(composer)) {
    container = container.parentElement;
  }
  if (!container?.parentElement) throw new Error("No chat container");
  return [...container.parentElement.children].filter(
    (child) => child !== container,
  );
};

describe("direct chat in the desktop theater", () => {
  it("moves one mounted composer and transcript, preserving drafts and attachments across toggles and reopening", async () => {
    const user = userEvent.setup();
    const { container, unmount } = mount();
    const composer = screen.getByRole("textbox", { name: "Message" });
    const transcript = screen.getByTestId("transcript");
    // CSS layout, not a guessed 96px input offset: the dock's containing
    // block is the flexible transcript, while the growing composer is outside.
    const transcriptRegion = transcript.parentElement;
    expect(transcriptRegion).toHaveClass("relative", "flex-1", "min-h-0");
    // The dock loads lazily (licensed, hosted-only code).
    expect(transcriptRegion).toContainElement(
      await screen.findByRole("button", { name: "Open Agent’s screen" }),
    );
    expect(transcriptRegion).not.toContainElement(composer);
    expect(transcriptRegion?.nextElementSibling).toContainElement(composer);
    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    if (!fileInput) throw new Error("Missing composer file input");
    await user.type(composer, "Keep my draft");
    await user.upload(
      fileInput,
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open computer" }));
    let dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByRole("textbox", { name: "Message" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Chat" }),
    ).toHaveAttribute("aria-pressed", "false");
    await user.click(within(dialog).getByRole("button", { name: "Chat" }));
    expect(within(dialog).getByRole("textbox", { name: "Message" })).toBe(
      composer,
    );
    expect(within(dialog).getByTestId("transcript")).toBe(transcript);
    expect(composer).toHaveValue("Keep my draft");
    expect(within(dialog).getByText("notes.txt")).toBeInTheDocument();
    await user.type(composer, " from theater");

    await user.click(within(dialog).getByRole("button", { name: "Chat" }));
    expect(dialog).toContainElement(composer);
    expect(
      within(dialog).queryByRole("textbox", { name: "Message" }),
    ).toBeNull();
    expect(composer).toHaveValue("Keep my draft from theater");
    await user.click(within(dialog).getByRole("button", { name: "Chat" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Back to the chat" }),
    );
    expect(container).toContainElement(composer);
    expect(container).toContainElement(transcript);
    await user.click(screen.getByRole("button", { name: "Open computer" }));
    dialog = screen.getByRole("dialog");
    // Chat was enabled at collapse, and is remembered on reopen.
    expect(within(dialog).getByRole("textbox", { name: "Message" })).toBe(
      composer,
    );
    expect(within(dialog).getByText("notes.txt")).toBeInTheDocument();
    expect(document.querySelectorAll('[aria-label="Message"]')).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-testid="transcript"]'),
    ).toHaveLength(1);
    expect(spies.transcriptMount).toHaveBeenCalledTimes(1);
    expect(spies.threadMount).toHaveBeenCalledTimes(1);
    expect(spies.transcriptUnmount).not.toHaveBeenCalled();
    expect(spies.threadUnmount).not.toHaveBeenCalled();
    expect(spies.upload).toHaveBeenCalledTimes(1);
    await user.click(
      within(dialog).getByRole("button", { name: "Send message" }),
    );
    expect(spies.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Keep my draft from theater",
        attachments: [expect.objectContaining({ id: "attachment-1" })],
      }),
    );
    unmount();
    expect(spies.transcriptUnmount).toHaveBeenCalledTimes(1);
    expect(spies.threadUnmount).toHaveBeenCalledTimes(1);
  });

  it("keeps the chat whole and mounted once while the dock's code loads", async () => {
    let arrive!: () => void;
    dockChunk.arrived = new Promise<void>((resolve) => (arrive = resolve));
    // A fresh module: its lazy dock has never loaded, as on a page's first
    // chat render (an earlier test here already loaded the shared one).
    vi.resetModules();
    const { DirectThreadSection: FirstVisit } =
      await import("./direct-thread-section");
    const client = new QueryClient();
    render(routeTree(client, <FirstVisit />));

    // The chat is up before the dock's code: loading the dock is the dock's
    // business, never a reason to blank the conversation.
    expect(screen.queryByText(ROUTE_LOADING)).toBeNull();
    const composer = screen.getByRole("textbox", { name: "Message" });
    await act(async () => {
      arrive();
      await dockChunk.arrived;
    });
    await screen.findByRole("button", { name: "Open Agent’s screen" });

    expect(chatContainerSiblings()).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
    expect(spies.threadMount).toHaveBeenCalledTimes(1);
  });

  it("comes back from a route-level hide in one piece, with the draft kept", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    const pending: { promise: Promise<void> | null } = { promise: null };
    const RouteData = () => {
      if (pending.promise) use(pending.promise);
      return null;
    };
    const tree = () =>
      routeTree(
        client,
        <>
          <DirectThreadSection />
          <RouteData />
        </>,
      );
    const { rerender } = render(tree());
    await screen.findByRole("button", { name: "Open Agent’s screen" });
    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "Half typed");

    // Something else under the route boundary suspends: React hides the chat
    // behind the fallback, then shows the same tree again.
    let resolve!: () => void;
    pending.promise = new Promise<void>((done) => (resolve = done));
    await act(async () => {
      rerender(tree());
    });
    expect(screen.getByText(ROUTE_LOADING)).toBeInTheDocument();
    await act(async () => {
      pending.promise = null;
      resolve();
    });
    await screen.findByRole("button", { name: "Open Agent’s screen" });

    expect(screen.queryByText(ROUTE_LOADING)).toBeNull();
    expect(chatContainerSiblings()).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
    expect(composer).toHaveValue("Half typed");
    expect(spies.threadMount).toHaveBeenCalledTimes(1);
  });

  it("comes back from a hidden Activity in one piece, with the draft kept", async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    const tree = (mode: "visible" | "hidden") => (
      <QueryClientProvider client={client}>
        <Activity mode={mode}>
          <DirectThreadSection />
        </Activity>
      </QueryClientProvider>
    );
    const { rerender } = render(tree("visible"));
    await screen.findByRole("button", { name: "Open Agent’s screen" });
    const composer = screen.getByRole("textbox", { name: "Message" });
    await user.type(composer, "Half typed");

    rerender(tree("hidden"));
    rerender(tree("visible"));

    // A hidden Activity disconnects effects by design, so the proof of a kept
    // subtree is the same composer node with the same draft.
    expect(chatContainerSiblings()).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
    expect(composer).toHaveValue("Half typed");
  });

  it("does not offer a no-op desktop action when previews are unavailable", () => {
    spies.previews = false;
    mount();
    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open computer" })).toBeNull();
    expect(screen.queryByRole("button", { name: /screen/ })).toBeNull();
    expect(spies.transcriptMount).toHaveBeenCalledTimes(1);
  });
});
