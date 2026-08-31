// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCron } from "@/lib/api";

/**
 * The schedule dialog's LAYOUT contract, which is the bug this file exists
 * for: a schedule's prompt is a runbook in practice, and the dialog used to
 * grow with it — off both ends of a `fixed` element nothing can scroll to, so
 * the title and Save became unreachable at exactly the moment you needed
 * them. jsdom does no layout, so height is not assertable here; what IS
 * assertable is the structure that makes the overflow survivable, and it is
 * the whole fix:
 *
 *   1. the frame is bounded and column-laid-out (max-height + flex-col),
 *   2. the fields sit in a scroll region (`data-slot="dialog-body"`),
 *   3. the header and footer live OUTSIDE it, so they cannot scroll away,
 *   4. the one field that grows with its content has a ceiling.
 *
 * Real geometry is verified in a headless browser instead (see the PR),
 * because only a layout engine can prove "Save is on screen".
 */

const mutation = () => ({ mutate: vi.fn(), isPending: false });

vi.mock("@/hooks/use-crons", () => ({
  useCreateCron: mutation,
  useUpdateCron: mutation,
  useDeleteCron: mutation,
}));

const { CronDialog } = await import("./cron-dialog");

/** A prompt of the shape that broke it: a full agent runbook. */
const LONG_PROMPT = Array.from(
  { length: 80 },
  (_, index) =>
    `STEP ${index} — Execute the runbook. Read the SKILL.md in full and follow it exactly.`,
).join("\n\n");

const cron = (overrides: Partial<AgentCron> = {}): AgentCron => ({
  id: "cr-1",
  agentId: "ag-1",
  name: "Health check",
  prompt: LONG_PROMPT,
  schedule: "0 9 * * *",
  timezone: "America/Los_Angeles",
  enabled: true,
  disabledReason: null,
  nextFireAt: "2026-08-08T09:00:00.000Z",
  lastFiredAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  ...overrides,
});

const renderDialog = (editing: AgentCron | null = cron()) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CronDialog
        agentId="ag-1"
        open
        onOpenChange={vi.fn()}
        editing={editing}
      />
    </QueryClientProvider>,
  );

const dialogBody = (): HTMLElement => {
  const body = document.querySelector<HTMLElement>('[data-slot="dialog-body"]');
  if (!body) throw new Error("the dialog has no scroll region");
  return body;
};

beforeEach(() => renderDialog());
afterEach(cleanup);

describe("a dialog carrying a long prompt", () => {
  it("bounds the frame to the viewport and stacks it as a column", () => {
    // Without BOTH, the fix is inert: the max-height is what stops the growth,
    // and the column is what lets the body (not the frame) absorb it.
    const frame = screen.getByRole("dialog");
    expect(frame.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(frame.className).toContain("flex-col");
  });

  it("scrolls the fields, and contains the scroll chaining", () => {
    const body = dialogBody();
    expect(body.className).toContain("overflow-y-auto");
    // min-h-0: a flex child refuses to shrink below its content without it,
    // so the scrollbar would never appear and the frame would grow anyway.
    expect(body.className).toContain("min-h-0");
    // The page behind a modal must not scroll when the body hits its end.
    expect(body.className).toContain("overscroll-contain");
  });

  it("keeps the title and every action OUT of the scroll region", () => {
    // The actual complaint: the buttons rode away with the content.
    const body = dialogBody();
    for (const name of ["Save", "Cancel", "Delete", "Close"]) {
      expect(body).not.toContainElement(screen.getByRole("button", { name }));
    }
    expect(body).not.toContainElement(
      screen.getByRole("heading", { name: "Edit schedule" }),
    );
  });

  it("caps the prompt field so one input cannot claim the whole body", () => {
    // `field-sizing-content` grows the textarea with what you type; the cap is
    // what keeps the schedule fields below it reachable.
    const prompt = screen.getByLabelText("What should it do?");
    expect(prompt).toHaveValue(LONG_PROMPT);
    expect(prompt.className).toMatch(/max-h-/);
  });

  it("still shows every field, prompt length notwithstanding", () => {
    // The scroll region must not be a way to lose inputs: they are present
    // and labelled, which is what a screen reader and a keyboard walk find.
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toBeInTheDocument();
    expect(screen.getByLabelText("At")).toBeInTheDocument();
    const body = dialogBody();
    expect(body).toContainElement(screen.getByLabelText("Name"));
    expect(body).toContainElement(screen.getByLabelText("Timezone"));
  });
});
