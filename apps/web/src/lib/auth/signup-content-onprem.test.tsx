// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextValue } from "@/lib/auth/types";

/**
 * The self-hosted sign-up screen — the first thing an operator ever sees on a
 * fresh install, and the front door for every account after it.
 *
 * What is worth pinning here is the things that make it safe rather than the
 * markup: it refuses a password the server would refuse anyway (so the failure
 * is inline instead of a round trip), it tells an upgrading operator their data
 * is coming with them, it frames first-account vs ordinary signups honestly,
 * and it shows the server's refusal verbatim rather than a generic "something
 * went wrong".
 */

const auth: Partial<AuthContextValue> = {};

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => auth,
}));

// The post-auth redirect drives the router and the API; neither is under test
// here, and both need a Next runtime this environment does not have.
vi.mock("@/lib/auth/use-post-auth-redirect", () => ({
  usePostAuthRedirect: () => {},
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

import { OnpremSignupContent } from "./signup-content-onprem";

const signUp = vi.fn();

beforeEach(() => {
  signUp.mockReset().mockResolvedValue(undefined);
  Object.assign(auth, {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    signUpWithPassword: signUp,
  });
  searchParams.forEach((_v, k) => searchParams.delete(k));
});

afterEach(cleanup);

const renderScreen = (
  props?: Partial<Parameters<typeof OnpremSignupContent>[0]>,
) =>
  render(
    <OnpremSignupContent
      googleConfigured={false}
      firstAccount={false}
      adoptsExistingInstall={false}
      {...props}
    />,
  );

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  password: string,
) => {
  await user.type(screen.getByPlaceholderText("Name"), "Operator");
  await user.type(screen.getByPlaceholderText("Email"), "op@example.test");
  await user.type(screen.getByPlaceholderText("Password"), password);
};

describe("self-hosted sign-up screen", () => {
  it("creates the account and says what it is for", () => {
    renderScreen();
    expect(
      screen.getByRole("heading", { name: "Create your account" }),
    ).toBeTruthy();
    expect(screen.getByText(/organization of its own/i)).toBeTruthy();
  });

  it("tells the deployment's first account it is first", () => {
    renderScreen({ firstAccount: true });
    expect(screen.getByText(/You are the first here/i)).toBeTruthy();
  });

  it("submits name, email and password", async () => {
    const user = userEvent.setup();
    renderScreen();
    await fill(user, "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(signUp).toHaveBeenCalledWith({
      name: "Operator",
      email: "op@example.test",
      password: "correct horse battery",
    });
  });

  it("refuses a short password without asking the server", async () => {
    const user = userEvent.setup();
    renderScreen();
    await fill(user, "short");
    await user.tab();

    expect(screen.getByText(/at least 8 characters/i)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Create account" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("shows the server's own refusal, not a generic failure", async () => {
    signUp.mockRejectedValue(
      new Error("An account already exists for that email."),
    );
    const user = userEvent.setup();
    renderScreen();
    await fill(user, "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeTruthy();
    });
  });

  it("tells an upgrading operator their data comes with them", () => {
    // Without this line the screen looks exactly like a fresh install, and
    // somebody who has been running OneCLI for months has every reason to
    // think they are about to start over.
    renderScreen({ adoptsExistingInstall: true });
    expect(
      screen.getByText(
        /existing organization, workspaces, agents and API keys/i,
      ),
    ).toBeTruthy();
  });

  it("offers Google only where it is configured", () => {
    renderScreen();
    expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();

    cleanup();
    renderScreen({ googleConfigured: true });
    expect(screen.getByRole("button", { name: /Google/ })).toBeTruthy();
  });

  it("locks the email to the invitation it came from", async () => {
    // The invitation is addressed to one person. An account under a different
    // address could not accept it, so editing the field can only produce a
    // dead end — and the address itself was resolved from the token
    // server-side, not from the URL.
    renderScreen({
      invitation: {
        token: "tok-1",
        email: "invited@acme.test",
        organizationName: "Acme",
      },
    });

    const emailField = screen.getByPlaceholderText("Email") as HTMLInputElement;
    expect(emailField.value).toBe("invited@acme.test");
    expect(emailField.readOnly).toBe(true);
    expect(screen.getByRole("heading", { name: "Join the team" })).toBeTruthy();
    expect(screen.getByText(/Acme/)).toBeTruthy();
  });

  it("renders the reason a redirected social sign-up was refused", async () => {
    // A refused Google sign-up comes back as a redirect, not a response, so
    // its reason arrives in the query string.
    searchParams.set("error", "SIGNUP_BLOCKED_BY_UPGRADE");
    renderScreen();
    expect(screen.getByText(/finishing an upgrade/i)).toBeTruthy();
  });

  it("offers the login screen — except to invited and first-run visitors", () => {
    // The invited screen stays single-purpose (a plain login link would lose
    // the invitation token), and while the deployment awaits its first
    // account the login page redirects straight back here — the link would
    // be a silent dead end.
    renderScreen();
    expect(
      screen.getByRole("link", { name: "Log in" }).getAttribute("href"),
    ).toBe("/auth/login");

    cleanup();
    renderScreen({
      invitation: {
        token: "tok-1",
        email: "invited@acme.test",
        organizationName: "Acme",
      },
    });
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();

    cleanup();
    renderScreen({ firstAccount: true });
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();

    cleanup();
    renderScreen({ firstAccount: true, adoptsExistingInstall: true });
    expect(screen.queryByRole("link", { name: "Log in" })).toBeNull();
  });

  it("sends an invited Google signup back to the token-bearing URL", async () => {
    // The invitation token lives in this page's URL; the OAuth round-trip
    // must land back on it or the join (and the personal-org suppression)
    // silently never happens.
    window.history.replaceState(null, "", "/auth/signup?token=tok-1");
    try {
      const user = userEvent.setup();
      renderScreen({
        googleConfigured: true,
        invitation: {
          token: "tok-1",
          email: "invited@acme.test",
          organizationName: "Acme",
        },
      });
      await user.click(screen.getByRole("button", { name: /Google/ }));

      expect(auth.signIn).toHaveBeenCalledWith({
        callbackURL: expect.stringContaining("token=tok-1"),
      });
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
