// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContact } from "@/lib/api";

/**
 * One outbound-only contact (an app the agent messaged on its own).
 * Acceptance behaviors: the badge says whether the agent may message it
 * without asking and, pressed, asks that question in full and offers the
 * three words; choosing one mutates with THIS contact's id; the current
 * word is a no-op; Remove lives last in the … menu and is confirm-gated.
 */

const mocks = vi.hoisted(() => ({
  setPolicy: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/hooks/use-channels", () => ({
  useSetContactPolicy: () => ({
    mutate: mocks.setPolicy,
    isPending: false,
    variables: undefined,
  }),
  useDeleteContact: () => ({
    // Instant remove: the row awaits only to say "removed" afterwards.
    mutateAsync: (id: string) => {
      mocks.remove(id);
      return Promise.resolve();
    },
    isPending: false,
    variables: undefined,
  }),
}));

import { ContactRow } from "./contact-row";

const contact = (policy: AgentContact["policy"]): AgentContact => ({
  id: "c-1",
  kind: "app",
  externalRef: "B1",
  displayName: "Jira",
  policy,
  updatedAt: "2026-09-16T00:00:00Z",
});

const renderRow = (c: AgentContact) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactRow agentId="ag-1" agentName="Donna" contact={c} />
    </QueryClientProvider>,
  );

const trigger = () =>
  screen.getByRole("button", { name: /Can Donna message Jira on its own/ });

beforeEach(() => {
  mocks.setPolicy.mockReset();
  mocks.remove.mockReset();
});

describe("ContactRow", () => {
  it("the badge is the standing; pressed, it asks the question and mutates with this contact's id", async () => {
    renderRow(contact("ask"));
    expect(screen.getByText("Asks you first")).toBeDefined();
    await userEvent.click(trigger());
    expect(screen.getByText(/on its own\?/)).toBeDefined();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Without asking/ }),
    );
    expect(mocks.setPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.setPolicy.mock.calls[0]![0]).toEqual({
      contactId: "c-1",
      policy: "allow",
    });
  });

  it("choosing the current word is a no-op", async () => {
    renderRow(contact("blocked"));
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: /^Block/ }));
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("Remove is the … menu's item and is confirm-gated: only the dialog's Remove fires", async () => {
    renderRow(contact("allow"));
    await userEvent.click(
      screen.getByRole("button", { name: "More for Jira" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/ask you again before messaging/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.remove).toHaveBeenCalledWith("c-1");
  });

  it("cancel closes the dialog without firing", async () => {
    renderRow(contact("allow"));
    await userEvent.click(
      screen.getByRole("button", { name: "More for Jira" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
