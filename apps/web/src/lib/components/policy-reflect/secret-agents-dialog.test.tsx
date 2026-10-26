// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grants, type SecretAgentAccess } from "@/lib/api";
import { SecretAgentsDialog } from "./secret-agents-dialog";

// No per-keystroke setTimeout: these tests type a lot and need no pacing.
const user = userEvent.setup({ delay: null });

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/connections",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      forSecret: vi.fn(),
      attachSecret: vi.fn().mockResolvedValue({}),
      detachSecret: vi.fn().mockResolvedValue({}),
    },
  };
});

const access = (agents: SecretAgentAccess["agents"]): SecretAgentAccess => ({
  secretId: "sec-1",
  agents,
});

const renderDialog = (justAdded?: boolean) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <SecretAgentsDialog
      secretId="sec-1"
      secretName="Stripe API"
      justAdded={justAdded}
      open
      onOpenChange={vi.fn()}
    />,
    { wrapper },
  );
};

describe("SecretAgentsDialog", () => {
  afterEach(() => {
    vi.mocked(grants.forSecret).mockReset();
    vi.mocked(grants.attachSecret).mockClear();
    vi.mocked(grants.detachSecret).mockClear();
  });

  it("lists every agent with its own switch, reading the secret's real access", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(
      access([
        { agentId: "a1", name: "Arik", granted: false, orgGranted: false },
        { agentId: "a2", name: "Donna", granted: true, orgGranted: false },
      ]),
    );
    renderDialog(true);

    expect(screen.getByText("Stripe API added")).toBeInTheDocument();
    // Never claims "off for everyone" before the access is known…
    expect(screen.queryByText(/It's off for every agent/)).toBeNull();
    expect(
      await screen.findByRole("switch", { name: "Attach Arik" }),
    ).not.toBeChecked();
    // …nor once it is: Donna is on.
    expect(screen.queryByText(/It's off for every agent/)).toBeNull();
    expect(screen.getByRole("switch", { name: "Detach Donna" })).toBeChecked();
    expect(grants.forSecret).toHaveBeenCalledWith("sec-1");
  });

  it("turns an agent on and off through the same attach/detach the agent page writes, then rereads", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(
      access([
        { agentId: "a1", name: "Arik", granted: false, orgGranted: false },
        { agentId: "a2", name: "Donna", granted: true, orgGranted: false },
      ]),
    );
    renderDialog();
    // Reopened to edit: never claims everyone is off (Donna is on).
    expect(screen.getByText("Stripe API agents")).toBeInTheDocument();
    expect(screen.queryByText(/It's off for every agent/)).toBeNull();

    await user.click(
      await screen.findByRole("switch", { name: "Attach Arik" }),
    );
    await waitFor(() =>
      expect(grants.attachSecret).toHaveBeenCalledWith("a1", "sec-1"),
    );
    await user.click(screen.getByRole("switch", { name: "Detach Donna" }));
    await waitFor(() =>
      expect(grants.detachSecret).toHaveBeenCalledWith("a2", "sec-1"),
    );
    // Each write invalidates the grants namespace, so the window rereads.
    await waitFor(() =>
      expect(vi.mocked(grants.forSecret).mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("says a just-added secret is off for every agent once that is known", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(
      access([
        { agentId: "a1", name: "Arik", granted: false, orgGranted: false },
      ]),
    );
    renderDialog(true);
    expect(
      await screen.findByText(/It's off for every agent/),
    ).toBeInTheDocument();
  });

  it("moves the switch on click, before the write answers, and puts it back if the write fails", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(
      access([
        { agentId: "a1", name: "Arik", granted: false, orgGranted: false },
      ]),
    );
    let fail!: (error: Error) => void;
    vi.mocked(grants.attachSecret).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }) as never,
    );
    renderDialog();

    await user.click(
      await screen.findByRole("switch", { name: "Attach Arik" }),
    );
    // Instant: on while the API is still thinking.
    expect(
      await screen.findByRole("switch", { name: "Detach Arik" }),
    ).toBeChecked();

    fail(new Error("nope"));
    // Rolled back to the truth: off again.
    expect(
      await screen.findByRole("switch", { name: "Attach Arik" }),
    ).not.toBeChecked();
  });

  it("shows an org-granted agent on and locked: a workspace switch can't take it away", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(
      access([
        { agentId: "a1", name: "Arik", granted: false, orgGranted: true },
      ]),
    );
    renderDialog();

    const toggle = await screen.findByRole("switch", { name: "Detach Arik" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Via organization")).toBeInTheDocument();
  });

  it("points at creating an agent when the workspace has none", async () => {
    vi.mocked(grants.forSecret).mockResolvedValue(access([]));
    renderDialog();

    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Agents" })).toHaveAttribute(
      "href",
      "/w/ws-1/agents",
    );
  });

  it("says so instead of showing switches over unknown state when the read fails", async () => {
    vi.mocked(grants.forSecret).mockRejectedValue(new Error("boom"));
    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load agent access for this connection.",
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
