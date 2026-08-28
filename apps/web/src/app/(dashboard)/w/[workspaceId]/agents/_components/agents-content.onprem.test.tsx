// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The ONPREM arm of the create door (the cloud arm lives in
 * `agents-content.test.tsx`): a self-host deployment runs its OWN runner, so
 * a legacy user's hosted entry opens hosted creation directly — there is no
 * migration for OneCLI to run and no call to book.
 */

// IS_CLOUD is resolved at module load — pin the edition before imports.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({
    data: [{ id: "ag-byo", kind: "byo", name: "byo agent" }],
    isPending: false,
  }),
  useCreateAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateHostedAgent: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
    error: null,
  }),
}));

vi.mock("@/hooks/use-grants", () => ({
  useGrantsSummary: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => "ready",
  useHomeDurabilityMessage: () => null,
}));

vi.mock("./agent-card", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => (
    <div>{agent.name}</div>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/ws-1/agents",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ workspaceId: "ws-1" }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const { AgentsContent } = await import("./agents-content");

// The mounted create dialogs embed SecretDialog, which reads the query client.
const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentsContent />
    </QueryClientProvider>,
  );

afterEach(cleanup);

describe("the create door on self-host", () => {
  it("opens hosted CREATION from a legacy user's chevron — never a sales call", async () => {
    renderPage();
    await userEvent.click(
      screen.getByRole("button", { name: /more ways to create an agent/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /new hosted agent/i }),
    );
    // The hosted create dialog, on the deployment's own runner.
    expect(await screen.findByPlaceholderText(/Support Triage/i)).toBeTruthy();
    expect(screen.queryByText(/book 15 minutes/i)).toBeNull();
  });
});
