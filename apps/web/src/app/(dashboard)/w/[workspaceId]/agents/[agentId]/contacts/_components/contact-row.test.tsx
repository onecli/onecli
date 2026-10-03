// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContact } from "@/lib/api";

/**
 * One outbound contact (someone the agent messaged on its own). Acceptance
 * behaviors: the badge says the standing and, pressed, offers the three
 * words; choosing one mutates with THIS contact's id; the current word is
 * a no-op; Remove lives last in the … menu and is confirm-gated.
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
    mutate: mocks.remove,
    isPending: false,
    variables: undefined,
  }),
}));

import { ContactRow } from "./contact-row";

const contact = (policy: AgentContact["policy"]): AgentContact => ({
  id: "c-1",
  kind: "person",
  externalRef: "U1",
  displayName: "Dana",
  policy,
  updatedAt: "2026-09-16T00:00:00Z",
});

const renderRow = (c: AgentContact) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactRow agentId="ag-1" contact={c} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mocks.setPolicy.mockReset();
  mocks.remove.mockReset();
});

describe("ContactRow", () => {
  it("the badge is the standing; pressed, it offers the three words and mutates with this contact's id", async () => {
    renderRow(contact("ask"));
    expect(screen.getByText("Asks first")).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", {
        name: /Whether the agent may message Dana on its own/,
      }),
    );
    expect(screen.getByText("Always allow")).toBeDefined();
    expect(screen.getByText("Ask me first")).toBeDefined();
    expect(screen.getByText("Block")).toBeDefined();
    await userEvent.click(screen.getByText("Always allow"));
    expect(mocks.setPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.setPolicy.mock.calls[0]![0]).toEqual({
      contactId: "c-1",
      policy: "allow",
    });
  });

  it("choosing the current word is a no-op", async () => {
    renderRow(contact("blocked"));
    await userEvent.click(
      screen.getByRole("button", {
        name: /Whether the agent may message Dana on its own/,
      }),
    );
    await userEvent.click(screen.getByText("Block"));
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("Remove is the … menu's item and is confirm-gated: only the dialog's Remove fires", async () => {
    renderRow(contact("allow"));
    await userEvent.click(
      screen.getByRole("button", { name: "More for Dana" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/ask you again before messaging/)).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.remove).toHaveBeenCalledWith("c-1", expect.anything());
  });

  it("cancel closes the dialog without firing", async () => {
    renderRow(contact("allow"));
    await userEvent.click(
      screen.getByRole("button", { name: "More for Dana" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
