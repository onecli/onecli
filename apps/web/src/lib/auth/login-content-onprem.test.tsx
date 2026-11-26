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
// What the post-auth sync reports: null while it runs, a sentence when it
// cannot finish.
const sync = vi.hoisted((): { error: string | null } => ({ error: null }));

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => auth,
}));

vi.mock("@/lib/auth/use-post-auth-redirect", () => ({
  usePostAuthRedirect: () => sync.error,
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));
vi.mock("next/image", () => ({ default: () => null }));

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
  sync.error = null;
});

afterEach(cleanup);

const signIntoForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByPlaceholderText("Email"), "op@example.test");
  await user.type(screen.getByPlaceholderText("Password"), "hunter22hunter");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("self-hosted sign-in screen", () => {
  it("signs in with email and password", async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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

  it("keeps the form up while the session is still being checked", () => {
    // Nearly everyone here is signed out: a spinner in its place would
    // flash the form away and back on every visit.
    Object.assign(auth, { isLoading: true });
    const { container } = render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("gives way to the dashboard's skeleton once signed in", () => {
    Object.assign(auth, { isAuthenticated: true });
    const { container } = render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    expect(container.querySelector("[data-agent-nav-skeleton]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.textContent).not.toMatch(/Signing you in|Loading\.\.\./);
  });

  it("replaces the skeleton with the reason a signed-in sync could not finish", () => {
    Object.assign(auth, { isAuthenticated: true });
    sync.error = "Could not reach the server. Reload to try again.";
    const { container } = render(
      <OnpremLoginContent googleConfigured={false} emailConfigured={false} />,
    );
    expect(screen.getByRole("alert").textContent).toBe(sync.error);
    expect(container.querySelector("[data-agent-nav-skeleton]")).toBeNull();
  });
});
