// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWebhook } from "@/lib/api";

/**
 * The webhook dialog's two contracts:
 *
 *  1. Create does not close — the same dialog frame swaps its body to the
 *     "Webhook ready" step carrying the URL, because that URL is the only
 *     thing the user needs next (and a second dialog would be one more
 *     thing to dismiss). Done closes it.
 *  2. The cron dialog's layout law: a bounded flex-col frame, the fields in
 *     a scroll region, header and footer outside it, the growing field
 *     capped — so a runbook-length instruction never pushes Save off-screen.
 */

const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/hooks/use-webhooks", () => ({
  useCreateWebhook: () => ({ mutate: mutations.create, isPending: false }),
  useUpdateWebhook: () => ({ mutate: mutations.update, isPending: false }),
  useDeleteWebhook: () => ({ mutate: mutations.remove, isPending: false }),
}));

const { WebhookDialog } = await import("./webhook-dialog");

const created: AgentWebhook = {
  id: "wh-1",
  agentId: "ag-1",
  name: "Meeting notes",
  instructions: "File each action item.",
  url: "https://api.example.test/v1/hooks/whk_new",
  enabled: true,
  disabledReason: null,
  lastReceivedAt: null,
  lastOutcome: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const onOpenChange = vi.fn();

const renderDialog = (editing: AgentWebhook | null = null) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WebhookDialog
        agentId="ag-1"
        open
        onOpenChange={onOpenChange}
        editing={editing}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  for (const m of Object.values(mutations)) m.mockReset();
  onOpenChange.mockReset();
});
afterEach(cleanup);

describe("create", () => {
  it("submits the trimmed fields and then shows the URL in the same dialog", async () => {
    mutations.create.mockImplementation(
      (_input: unknown, handlers: { onSuccess: (h: AgentWebhook) => void }) =>
        handlers.onSuccess(created),
    );
    renderDialog();
    await userEvent.type(screen.getByLabelText("Name"), "  Meeting notes ");
    await userEvent.type(
      screen.getByLabelText("What should it do with each event?"),
      " File each action item. ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(mutations.create).toHaveBeenCalledWith(
      { name: "Meeting notes", instructions: "File each action item." },
      expect.anything(),
    );
    // Not closed: the frame is still here, now as the ready step.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Webhook ready" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(created.url);
    expect(
      screen.getByRole("button", { name: "Copy webhook URL" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps Create disabled until both fields have content", async () => {
    renderDialog();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "x");
    expect(create).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("What should it do with each event?"),
      "y",
    );
    expect(create).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("edit", () => {
  it("prefills, shows the URL, saves a patch, and offers Delete", async () => {
    renderDialog(created);
    expect(
      screen.getByRole("dialog", { name: "Edit webhook" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Meeting notes");
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(created.url);

    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutations.update).toHaveBeenCalledWith(
      {
        id: "wh-1",
        input: { name: "Renamed", instructions: "File each action item." },
      },
      expect.anything(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mutations.remove).toHaveBeenCalledWith("wh-1", expect.anything());
  });
});

describe("the layout law (runbook-length instructions)", () => {
  it("bounds the frame, scrolls only the body, caps the growing field", () => {
    renderDialog(created);
    const content = screen.getByRole("dialog");
    expect(content.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(content.className).toMatch(/\bflex-col\b/);

    const body = document.querySelector<HTMLElement>(
      '[data-slot="dialog-body"]',
    );
    if (!body) throw new Error("the dialog has no scroll region");
    expect(body.className).toMatch(/overflow-y-auto/);
    // Fields inside; header and footer outside.
    expect(body.contains(screen.getByLabelText("Name"))).toBe(true);
    expect(body.contains(screen.getByText("Edit webhook"))).toBe(false);
    expect(body.contains(screen.getByRole("button", { name: "Save" }))).toBe(
      false,
    );
    expect(
      screen.getByLabelText("What should it do with each event?").className,
    ).toMatch(/max-h-\[min\(18rem,32dvh\)\]/);
  });
});
