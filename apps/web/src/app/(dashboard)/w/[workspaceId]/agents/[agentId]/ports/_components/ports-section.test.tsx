// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPortShare } from "@/lib/api";

/**
 * The Ports section (the webhooks-section pattern): one describe per state
 * the view can be in. Hooks are mocked at the module seam; the API client
 * and the DB laws are covered in the api package.
 */

type MutateOptions = {
  onSuccess?: (result: unknown) => void;
  onError?: (error: Error) => void;
};

const state = vi.hoisted(() => ({
  shares: [] as unknown[],
  listening: [] as number[],
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  share: vi.fn<(port: number, options?: MutateOptions) => void>(),
  unshare: vi.fn<(port: number, options?: MutateOptions) => void>(),
  /** The port a share/unshare is in flight for (null = idle). */
  sharing: null as number | null,
  unsharing: null as number | null,
}));

/** The slice of sonner the section uses: a plain toast (with an action) plus success/error. */
type ToastOptions = { action?: { label: string; onClick: () => void } };
const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn<(message: string, options?: ToastOptions) => void>(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
);
vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/hooks/use-ports", () => ({
  usePorts: () => ({
    data:
      state.isPending || state.isError
        ? undefined
        : { shares: state.shares, listening: state.listening },
    isPending: state.isPending,
    isError: state.isError,
    refetch: state.refetch,
  }),
  useSharePort: () => ({
    mutate: state.share,
    isPending: state.sharing !== null,
    variables: state.sharing ?? undefined,
  }),
  useUnsharePort: () => ({
    mutate: state.unshare,
    isPending: state.unsharing !== null,
    variables: state.unsharing ?? undefined,
  }),
  portToastId: (agentId: string, port: number) => `port:${agentId}:${port}`,
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
}));

const { PortsSection } = await import("./ports-section");

const share = (
  overrides: Partial<SandboxPortShare> = {},
): SandboxPortShare => ({
  id: "sp-1",
  port: 8080,
  hostname: "p8080-andy-ab12.preview.example",
  url: "https://p8080-andy-ab12.preview.example",
  visibility: "private",
  expiresAt: null,
  active: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PortsSection />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.shares = [];
  state.listening = [];
  state.isPending = false;
  state.isError = false;
  state.sharing = null;
  state.unsharing = null;
  state.refetch.mockReset();
  state.share.mockReset();
  state.unshare.mockReset();
  toastMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(cleanup);

describe("loading, failure, empty", () => {
  it("shows skeleton rows while pending (no layout jump) and no row actions", () => {
    state.isPending = true;
    renderSection();
    const list = screen.getByLabelText("Loading ports…");
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: /Share port/ })).toBeNull();
  });

  it("a failed first load explains itself and offers a retry that refetches", async () => {
    state.isError = true;
    renderSection();
    expect(screen.getByText(/Couldn’t load ports/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it("with nothing listening, says so, says it will show up on its own, and still offers the manual share", () => {
    renderSection();
    expect(screen.getByText(/Nothing is listening yet/)).toBeInTheDocument();
    expect(screen.getByText(/within a few seconds/)).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Share another port" }),
    ).toBeInTheDocument();
  });
});

describe("live", () => {
  it("the list is a polite live region, so a port that appears is announced without stealing focus", () => {
    state.listening = [3000];
    renderSection();
    expect(screen.getByRole("list")).toHaveAttribute("aria-live", "polite");
  });
});

describe("rows", () => {
  it("lists listening ports with a Share action, and shared ports with their link", () => {
    state.listening = [3000, 8080];
    state.shares = [share()];
    renderSection();
    expect(screen.getByText("3000")).toBeInTheDocument();
    expect(screen.getByText("8080")).toBeInTheDocument();
    // Private is a quiet visible word, not a third badge or a hover tooltip.
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /p8080-andy-ab12\.preview\.example/ }),
    ).toHaveAttribute("href", "https://p8080-andy-ab12.preview.example");
    expect(
      screen.getByRole("button", { name: "Stop sharing port 8080" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Share port 3000" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("listening")).toHaveLength(2);
  });

  it("a shared port that stopped listening stays listed as idle (a normal state, not a fault)", () => {
    state.listening = [];
    state.shares = [share()];
    renderSection();
    expect(screen.getByText("8080")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.queryByText(/not running/)).toBeNull();
  });

  it("a revoked share is not a row (only the listening set and live shares are)", () => {
    state.shares = [share({ active: false })];
    renderSection();
    expect(screen.queryByText("8080")).toBeNull();
    expect(screen.getByText(/Nothing is listening yet/)).toBeInTheDocument();
  });

  it("the share hostname is marked translate=no and truncates instead of overflowing", () => {
    state.shares = [
      share({
        hostname:
          "p8080-a-very-long-agent-name-that-goes-on-ab12.preview.example",
      }),
    ];
    renderSection();
    const host = screen.getByText(/a-very-long-agent-name/);
    expect(host).toHaveAttribute("translate", "no");
    expect(host.className).toContain("truncate");
  });
});

describe("actions", () => {
  it("Share on a listening row calls the mutation with that port", async () => {
    state.listening = [3000];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Share port 3000" }),
    );
    expect(state.share).toHaveBeenCalledWith(3000, expect.anything());
  });

  it("the manual form has a real label, refuses junk inline, and shares a valid port", async () => {
    renderSection();
    const input = screen.getByRole("textbox", { name: "Share another port" });
    expect(input).toHaveAttribute("name", "port");
    expect(input).toHaveAttribute("autocomplete", "off");
    await userEvent.type(input, "70000");
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(state.share).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a port between 1 and 65535.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, "5173");
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(state.share).toHaveBeenCalledWith(5173, expect.anything());
  });

  it("the manual form refuses a port that is already shared, without a round trip", async () => {
    state.shares = [share()];
    renderSection();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Share another port" }),
      "8080",
    );
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(state.share).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Port 8080 is already shared.",
    );
  });

  it("only the row being shared is held; the other rows stay usable", () => {
    state.listening = [3000, 4000];
    state.sharing = 3000;
    renderSection();
    const acting = screen.getByRole("button", { name: "Share port 3000" });
    const other = screen.getByRole("button", { name: "Share port 4000" });
    expect(acting).toBeDisabled();
    expect(acting).toHaveTextContent("Sharing…");
    expect(other).toBeEnabled();
    expect(other).toHaveTextContent("Share");
  });

  it("Stop sharing calls unshare with the port, instantly: no spinner, no lock", async () => {
    state.listening = [8080];
    state.shares = [share()];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Stop sharing port 8080" }),
    );
    expect(state.unshare).toHaveBeenCalledWith(8080);
  });

  it("Undo is offered at once (it queues behind the stop) and re-shares in one click", async () => {
    state.listening = [8080];
    state.shares = [share()];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Stop sharing port 8080" }),
    );
    // No waiting on the server: the toast is up with the click.
    expect(toastMock).toHaveBeenCalledWith(
      "Stopped sharing port 8080",
      expect.objectContaining({
        id: "port:ag-1:8080",
        action: expect.objectContaining({ label: "Undo" }),
      }),
    );
    toastMock.mock.calls[0]?.[1]?.action?.onClick();
    expect(state.share).toHaveBeenCalledWith(8080, expect.anything());
  });

  it("Copy link copies the share URL and confirms in place, not with a toast", async () => {
    state.shares = [share()];
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    renderSection();
    const button = screen.getByRole("button", {
      name: "Copy link for port 8080",
    });
    await userEvent.click(button);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://p8080-andy-ab12.preview.example",
    );
    expect(button).toHaveTextContent("Copied");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
