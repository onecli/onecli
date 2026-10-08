// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WEBHOOKS_PER_AGENT } from "@onecli/api/validations/webhooks";
import type { AgentWebhook } from "@/lib/api";

/**
 * The Webhooks section, one describe per state the view can be in (the
 * schedules-section pattern): empty, rows (incl. the auto-disabled shapes
 * and the last-event line), the cap, and the actions. Hooks are mocked at
 * the module seam; the API client and the DB laws are covered elsewhere.
 */

const state = vi.hoisted(() => ({
  webhooks: [] as unknown[],
  isPending: false,
  isError: false,
  update: vi.fn(),
}));

vi.mock("@/hooks/use-webhooks", () => ({
  useWebhooks: () => ({
    data:
      state.isPending || state.isError
        ? undefined
        : { webhooks: state.webhooks },
    isPending: state.isPending,
    isError: state.isError,
  }),
  useCreateWebhook: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWebhook: () => ({ mutate: state.update, isPending: false }),
  useDeleteWebhook: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
}));

const { WebhooksSection } = await import("./webhooks-section");

const webhook = (overrides: Partial<AgentWebhook> = {}): AgentWebhook => ({
  id: "wh-1",
  agentId: "ag-1",
  name: "Meeting notes",
  instructions: "File each action item.",
  url: "https://api.example.test/v1/hooks/whk_abc",
  enabled: true,
  disabledReason: null,
  lastReceivedAt: null,
  lastOutcome: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WebhooksSection />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.webhooks = [];
  state.isPending = false;
  state.isError = false;
  state.update.mockReset();
});
afterEach(cleanup);

describe("loading and failure", () => {
  it("shows a spinner while pending", () => {
    state.isPending = true;
    renderSection();
    expect(screen.getByText("Loading webhooks")).toBeInTheDocument();
  });

  it("never renders toggles over a failed load", () => {
    state.isError = true;
    renderSection();
    expect(screen.getByRole("alert")).toHaveTextContent(/failed to load/);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

describe("empty", () => {
  it("offers creation with a product-neutral example", () => {
    renderSection();
    expect(screen.getByText("No webhooks yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New webhook/ }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/circleback/i);
  });
});

describe("rows", () => {
  it("renders the webhook with the pause switch AS the status and a copy action", () => {
    state.webhooks = [webhook()];
    renderSection();
    expect(screen.getByText("Meeting notes")).toBeInTheDocument();
    expect(screen.getByText("No events yet")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Pause Meeting notes" }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Copy Meeting notes URL" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Auto-disabled/)).not.toBeInTheDocument();
  });

  it("shows the last event and its outcome", () => {
    state.webhooks = [
      webhook({
        lastReceivedAt: "2026-10-02T09:30:00.000Z",
        lastOutcome: "failed",
      }),
    ];
    renderSection();
    expect(screen.getByText(/^Last event .* · failed$/)).toBeInTheDocument();
  });

  it("an auto-disabled row carries the ONE badge the switch cannot express", () => {
    state.webhooks = [
      webhook({ enabled: false, disabledReason: "failures" }),
      webhook({
        id: "wh-2",
        name: "Other",
        enabled: false,
        disabledReason: "authorization",
      }),
    ];
    renderSection();
    expect(screen.getByText("Auto-disabled: kept failing")).toBeInTheDocument();
    expect(
      screen.getByText("Auto-disabled: creator lost access"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Resume Other" }),
    ).not.toBeChecked();
  });

  it("disables New webhook at the cap and says why", () => {
    state.webhooks = Array.from({ length: MAX_WEBHOOKS_PER_AGENT }, (_, i) =>
      webhook({ id: `wh-${i}`, name: `Hook ${i}` }),
    );
    renderSection();
    const button = screen.getByRole("button", { name: /New webhook/ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(`Up to ${MAX_WEBHOOKS_PER_AGENT} per agent`),
    ).toBeInTheDocument();
  });
});

describe("actions", () => {
  it("the pause switch writes enabled:false", async () => {
    state.webhooks = [webhook()];
    renderSection();
    await userEvent.click(
      screen.getByRole("switch", { name: "Pause Meeting notes" }),
    );
    expect(state.update).toHaveBeenCalledWith(
      { id: "wh-1", input: { enabled: false } },
      expect.anything(),
    );
  });

  it("Edit opens the dialog pre-filled, with the URL to copy", async () => {
    state.webhooks = [webhook()];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Meeting notes" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Meeting notes");
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(
      "https://api.example.test/v1/hooks/whk_abc",
    );
  });

  it("New webhook opens an empty create dialog", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New webhook/ }));
    expect(
      screen.getByRole("dialog", { name: "New webhook" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});
