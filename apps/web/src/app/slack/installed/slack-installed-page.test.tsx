// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── /slack/installed — the landing for a MARKETPLACE install ────────────────
//
// An install begun in Slack's app directory carries no signed state, so the
// OAuth callback parks its code here and the organization comes from whoever
// signs in. The three branches that must hold:
//
// - no code at all           → never render a finish attempt (nothing to spend)
// - a code, signed OUT       → sign-in, with the code carried across the trip
// - a code, signed IN        → spend it
//
// Slack's review walks the signed-out branch specifically (a reviewer installs
// from the directory without a OneCLI account), which is why it is pinned.

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  redirectedTo: null as string | null,
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => state.session,
}));

vi.mock("@/lib/auth/default-org", () => ({
  getUserDefaultOrg: async () => ({ id: "org-1", name: "Acme Corp" }),
}));

// `redirect()` throws in Next; the stub records and throws the same way so a
// missing-code render cannot fall through to the components below.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirectedTo = url;
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("./_components/slack-installed-sign-in", () => ({
  SlackInstalledSignIn: ({ callbackUrl }: { callbackUrl: string }) => (
    <div data-testid="sign-in" data-callback={callbackUrl} />
  ),
}));
vi.mock("./_components/slack-installed-finish", () => ({
  SlackInstalledFinish: ({
    code,
    organization,
  }: {
    code: string;
    organization: { id: string; name: string } | null;
  }) => (
    <div
      data-testid="finish"
      data-code={code}
      data-org={organization?.id ?? ""}
    />
  ),
}));

import Page from "./page";

afterEach(() => {
  state.session = null;
  state.redirectedTo = null;
  cleanup();
});

describe("/slack/installed", () => {
  it("signed OUT with a code: sign-in carries the code back to this page", async () => {
    state.session = null;
    render(
      await Page({ searchParams: Promise.resolve({ code: "mp-code-1" }) }),
    );
    const signIn = screen.getByTestId("sign-in");
    // The whole point: the code survives the login round trip, so the person
    // lands back here able to finish. Losing it strands the install.
    expect(signIn.getAttribute("data-callback")).toBe(
      "/slack/installed?code=mp-code-1",
    );
    expect(screen.queryByTestId("finish")).toBeNull();
  });

  it("signed IN with a code: the code is handed to the finish step", async () => {
    state.session = { id: "u1", email: "admin@example.com" };
    render(
      await Page({ searchParams: Promise.resolve({ code: "mp-code-2" }) }),
    );
    expect(screen.getByTestId("finish").getAttribute("data-code")).toBe(
      "mp-code-2",
    );
    expect(screen.queryByTestId("sign-in")).toBeNull();
  });

  it("a code needing URL-escaping survives the round trip intact", async () => {
    state.session = null;
    render(await Page({ searchParams: Promise.resolve({ code: "a b&c=d" }) }));
    expect(screen.getByTestId("sign-in").getAttribute("data-callback")).toBe(
      "/slack/installed?code=a%20b%26c%3Dd",
    );
  });

  it("NO code: redirects instead of rendering a finish that cannot work", async () => {
    state.session = { id: "u1", email: "admin@example.com" };
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(state.redirectedTo).toBe("/");
  });

  it("NO code and signed out: sent to log in, not to the dashboard", async () => {
    state.session = null;
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(state.redirectedTo).toBe("/auth/login");
  });
});
