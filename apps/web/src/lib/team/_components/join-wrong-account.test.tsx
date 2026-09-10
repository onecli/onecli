// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── The switch-account screen ───────────────────────────────────────────────
//
// One button, and the ORDER of what it does is the whole contract: park the
// join URL FIRST, then sign out. The edition's `signOut` ends in a full
// navigation to the login screen, so anything written after it is lost — and
// the login screen's post-auth sync is what resumes the parked link as the
// invited account.

const signOut = vi.fn<() => Promise<void>>();
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ signOut }),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

import { JoinWrongAccount } from "./join-wrong-account";

const props = {
  orgName: "Lizo",
  invitedEmail: "m***@lizo.ai",
  currentEmail: "other@acme.test",
  callbackUrl: "/join?token=tok-1",
};

beforeEach(() => {
  signOut.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("JoinWrongAccount", () => {
  it("says who it was for and who is signed in, using only what it was handed", () => {
    render(<JoinWrongAccount {...props} />);

    expect(screen.getByRole("heading", { name: "Lizo" })).toBeInTheDocument();
    // The masked invitee appears in the explanation AND the button label;
    // the full address never does (it is not even handed in).
    expect(screen.getAllByText("m***@lizo.ai", { exact: false })).toHaveLength(
      2,
    );
    expect(screen.queryByText("max@lizo.ai", { exact: false })).toBeNull();
    expect(
      screen.getByText("other@acme.test", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign out and continue/i }),
    ).toBeEnabled();
  });

  it("parks the join URL BEFORE signing out, and stays disabled while it runs", async () => {
    let parkedWhenSigningOut: string | null = "unset";
    signOut.mockImplementation(async () => {
      parkedWhenSigningOut = localStorage.getItem("inviteCallbackUrl");
      // Never resolves: the real one hands off to a full navigation.
      await new Promise<void>(() => {});
    });

    render(<JoinWrongAccount {...props} />);
    const button = screen.getByRole("button", {
      name: /sign out and continue/i,
    });
    await userEvent.click(button);

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    // The slot was already written when sign-out started — that is what the
    // login screen resumes from after the new sign-in.
    expect(parkedWhenSigningOut).toBe("/join?token=tok-1");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/signing out/i);
  });

  it("re-enables the button when sign-out fails, keeping the parked link", async () => {
    signOut.mockRejectedValue(new Error("network"));

    render(<JoinWrongAccount {...props} />);
    const button = screen.getByRole("button", {
      name: /sign out and continue/i,
    });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    // A retry picks up where it left off — the slot is still there.
    expect(localStorage.getItem("inviteCallbackUrl")).toBe("/join?token=tok-1");
  });
});
