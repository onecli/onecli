// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invite dialog's job after the invitation exists.
 *
 * Delivery is additive: the link always works, email happens on top where a
 * provider is configured. What is pinned here is that the dialog never claims
 * a delivery that did not happen — the old flow toasted "Invitation sent" on a
 * deployment that had sent nothing at all.
 */

const create = vi.fn();
vi.mock("@/hooks/use-invitations", () => ({
  useCreateInvitation: () => ({ mutate: create, isPending: false }),
}));

const copy = vi.fn();
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy }),
}));

import { InviteDialog } from "./invite-dialog";

const JOIN_URL = "http://localhost:10254/join?token=abc";

beforeEach(() => {
  create.mockReset();
  copy.mockReset();
});
afterEach(cleanup);

const invite = async (emailed: boolean) => {
  create.mockImplementation((_input, opts) =>
    opts?.onSuccess?.({ id: "inv-1", joinUrl: JOIN_URL, emailed }),
  );
  const user = userEvent.setup();
  render(<InviteDialog open onOpenChange={() => {}} />);
  await user.type(
    screen.getByPlaceholderText("name@example.com"),
    "new@acme.test",
  );
  await user.click(screen.getByRole("button", { name: "Create invitation" }));
};

describe("invite dialog", () => {
  it("shows a copyable link once the invitation exists", async () => {
    await invite(true);
    await waitFor(() => {
      expect(screen.getByDisplayValue(JOIN_URL)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Copy invitation link" }),
    ).toBeTruthy();
  });

  it("says plainly when nothing was emailed", async () => {
    // The whole reason the link exists: a self-host with no mail provider.
    await invite(false);
    await waitFor(() => {
      expect(screen.getByText(/no email provider is configured/i)).toBeTruthy();
    });
    expect(screen.queryByText(/We emailed/)).toBeNull();
  });

  it("says an email went out when one did", async () => {
    await invite(true);
    await waitFor(() => {
      expect(screen.getByText(/We emailed new@acme.test/)).toBeTruthy();
    });
  });

  it("sends the typed address and the chosen role", async () => {
    await invite(true);
    expect(create).toHaveBeenCalledWith(
      { email: "new@acme.test", role: "member" },
      expect.anything(),
    );
  });
});
