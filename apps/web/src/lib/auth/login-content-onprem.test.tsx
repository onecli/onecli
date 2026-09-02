// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextValue } from "@/lib/auth/types";

/**
 * The self-hosted sign-in screen. Email and password is the floor on every
 * install; Google is an extra button where it happens to be configured.
 */

const auth: Partial<AuthContextValue> = {};

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => auth,
}));

vi.mock("@/lib/auth/use-post-auth-redirect", () => ({
  usePostAuthRedirect: () => {},
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

import { OnpremLoginContent } from "./login-content-onprem";

const signInWithPassword = vi.fn();
const signIn = vi.fn();

beforeEach(() => {
  signInWithPassword.mockReset().mockResolvedValue(undefined);
  signIn.mockReset();
  Object.assign(auth, {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    signIn,
    signOut: vi.fn(),
    signInWithPassword,
  });
  searchParams.forEach((_v, k) => searchParams.delete(k));
});

afterEach(cleanup);

const signIntoForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByPlaceholderText("Email"), "op@example.test");
  await user.type(screen.getByPlaceholderText("Password"), "hunter22hunter");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("self-hosted sign-in screen", () => {
  it("signs in with email and password", async () => {
    const user = userEvent.setup();
    render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    await signIntoForm(user);

    expect(signInWithPassword).toHaveBeenCalledWith(
      "op@example.test",
      "hunter22hunter",
    );
  });

  it("shows why the credentials were refused", async () => {
    signInWithPassword.mockRejectedValue(
      new Error("That email and password don't match an account."),
    );
    const user = userEvent.setup();
    render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    await signIntoForm(user);

    await waitFor(() => {
      expect(screen.getByText(/don't match an account/i)).toBeTruthy();
    });
    // ...and lets them try again, rather than leaving a dead form.
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("cannot be submitted empty", () => {
    render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("offers Google only where it is configured", () => {
    // A password-only install is the normal shape, not a misconfiguration.
    render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
    expect(screen.getByPlaceholderText("Password")).toBeTruthy();

    cleanup();
    render(<OnpremLoginContent googleConfigured emailConfigured={false} />);
    expect(screen.getByRole("button", { name: /Google/ })).toBeTruthy();
    expect(screen.getByPlaceholderText("Password")).toBeTruthy();
  });

  it("explains a refused social sign-in that redirected back here", () => {
    searchParams.set("error", "SIGNUP_BLOCKED_BY_UPGRADE");
    render(<OnpremLoginContent googleConfigured emailConfigured={false} />);
    expect(screen.getByText(/finishing an upgrade/i)).toBeTruthy();
  });

  it("offers the signup screen — registration is open", () => {
    render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    const link = screen.getByRole("link", { name: "Create an account" });
    expect(link.getAttribute("href")).toBe("/auth/signup");
  });
});
