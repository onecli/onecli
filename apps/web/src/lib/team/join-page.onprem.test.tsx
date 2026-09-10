// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── /join — every way a join link can resolve ───────────────────────────────
//
// The page is a server component that branches on two facts: whether the
// token is still redeemable, and who (if anyone) is signed in. What is pinned
// here is that each branch renders the screen the PR promises, and that the
// unusable screens reveal ONLY a status word — never the organization's name
// or the invitee's address, both of which a leaked or guessed token would
// otherwise expose.
//
// The self-host arm is the one exercised: `IS_CLOUD` is frozen at module load
// from the (unset) edition env, so the signed-out branch redirects to signup.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
});

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  user: null as { id: string; email: string } | null,
  pending: null as {
    email: string;
    organizationName: string;
    organizationSlug: string;
  } | null,
  acceptedOrgId: null as string | null,
  reason: "unknown" as "expired" | "accepted" | "cancelled" | "unknown",
  redirectedTo: null as string | null,
  reasonReads: 0,
  acceptedLookups: [] as { token: string; userId: string; email: string }[],
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => state.session,
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => state.user,
    },
  },
}));

vi.mock("@onecli/api/services/invitation-service", () => ({
  findPendingInvitationByToken: async () => state.pending,
  findAcceptedInvitationOrgForUser: async (
    token: string,
    userId: string,
    email: string,
  ) => {
    state.acceptedLookups.push({ token, userId, email });
    return state.acceptedOrgId;
  },
  explainUnavailableInvitation: async () => {
    state.reasonReads += 1;
    return state.reason;
  },
}));

// `redirect()` throws in Next; the stub records and throws the same way so a
// redirecting render cannot fall through to the components below.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirectedTo = url;
    throw new Error("NEXT_REDIRECT");
  },
}));

// The screens are stubbed to their props: this suite is about WHICH screen
// renders with WHAT, not about their markup.
vi.mock("./_components/join-form", () => ({
  JoinForm: ({ token, orgName }: { token: string; orgName: string }) => (
    <div data-testid="join-form" data-token={token} data-org={orgName} />
  ),
}));
vi.mock("./_components/join-sign-in", () => ({
  JoinSignIn: ({ callbackUrl }: { callbackUrl: string }) => (
    <div data-testid="join-sign-in" data-callback={callbackUrl} />
  ),
}));
vi.mock("./_components/join-unavailable", () => ({
  JoinUnavailable: ({
    reason,
    signedIn,
    callbackUrl,
    ...rest
  }: {
    reason: string;
    signedIn: boolean;
    callbackUrl: string;
  }) => (
    <div
      data-testid="join-unavailable"
      data-reason={reason}
      data-signed-in={String(signedIn)}
      data-callback={callbackUrl}
      data-extra-props={Object.keys(rest).join(",")}
    />
  ),
}));
vi.mock("./_components/join-wrong-account", () => ({
  JoinWrongAccount: ({
    orgName,
    invitedEmail,
    currentEmail,
    callbackUrl,
  }: {
    orgName: string;
    invitedEmail: string;
    currentEmail: string;
    callbackUrl: string;
  }) => (
    <div
      data-testid="join-wrong-account"
      data-org={orgName}
      data-invited={invitedEmail}
      data-current={currentEmail}
      data-callback={callbackUrl}
    />
  ),
}));

import JoinPage from "./join-page";

const renderJoin = async (token?: string) => {
  try {
    render(await JoinPage({ searchParams: Promise.resolve({ token }) }));
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "NEXT_REDIRECT") throw err;
  }
};

const invited = {
  email: "max@lizo.ai",
  organizationName: "Lizo",
  organizationSlug: "lizo",
};

beforeEach(() => {
  state.session = null;
  state.user = null;
  state.pending = null;
  state.acceptedOrgId = null;
  state.reason = "unknown";
  state.redirectedTo = null;
  state.reasonReads = 0;
  state.acceptedLookups = [];
});

afterEach(() => {
  cleanup();
});

describe("/join — a token that cannot be redeemed", () => {
  it.each(["expired", "accepted", "cancelled", "unknown"] as const)(
    "signed out, %s: explains with the status word only",
    async (reason) => {
      state.reason = reason;
      await renderJoin("tok-1");

      const card = screen.getByTestId("join-unavailable");
      expect(card).toHaveAttribute("data-reason", reason);
      expect(card).toHaveAttribute("data-signed-in", "false");
      // Only the status word and the way back to this link reach the screen:
      // the org name and invitee address never do.
      expect(card).toHaveAttribute("data-callback", "/join?token=tok-1");
      expect(card).toHaveAttribute("data-extra-props", "");
      expect(state.redirectedTo).toBeNull();
      // Nobody is signed in, so there is no accepter to look up.
      expect(state.acceptedLookups).toEqual([]);
    },
  );

  it("signed in as someone it was NOT accepted by: still explained, never redirected", async () => {
    state.session = { id: "ext-2", email: "other@acme.test" };
    state.user = { id: "user-2", email: "other@acme.test" };
    state.reason = "accepted";
    await renderJoin("tok-1");

    // The re-click lookup ran for THIS user and came back empty…
    expect(state.acceptedLookups).toEqual([
      { token: "tok-1", userId: "user-2", email: "other@acme.test" },
    ]);
    // …so the explanation is what renders, with the sign-in CTA swapped for
    // the dashboard one.
    const card = screen.getByTestId("join-unavailable");
    expect(card).toHaveAttribute("data-reason", "accepted");
    expect(card).toHaveAttribute("data-signed-in", "true");
    expect(state.redirectedTo).toBeNull();
  });

  it("re-clicked by the member who accepted it: straight into that organization", async () => {
    state.session = { id: "ext-1", email: "max@lizo.ai" };
    state.user = { id: "user-1", email: "max@lizo.ai" };
    state.acceptedOrgId = "org-lizo";
    await renderJoin("tok-1");

    expect(state.redirectedTo).toBe("/org/org-lizo/workspaces");
    expect(screen.queryByTestId("join-unavailable")).toBeNull();
    // Redirected before any explanation was even computed.
    expect(state.reasonReads).toBe(0);
  });

  it("signed in but with no user row yet: no accepter lookup, plain explanation", async () => {
    // The identity layer can hold a session whose DB row has not landed
    // (first sync still in flight); nothing here may assume the row exists.
    state.session = { id: "ext-9", email: "ghost@acme.test" };
    state.user = null;
    state.reason = "expired";
    await renderJoin("tok-1");

    expect(state.acceptedLookups).toEqual([]);
    expect(screen.getByTestId("join-unavailable")).toHaveAttribute(
      "data-reason",
      "expired",
    );
  });
});

describe("/join — a pending token", () => {
  beforeEach(() => {
    state.pending = invited;
  });

  it("signed out on self-host: sent to sign up with the token in the URL", async () => {
    await renderJoin("tok-1");

    expect(state.redirectedTo).toBe("/auth/signup?token=tok-1");
    expect(screen.queryByTestId("join-sign-in")).toBeNull();
  });

  it("signed in as the invitee: the join form, for this token and org", async () => {
    state.session = { id: "ext-1", email: "max@lizo.ai" };
    state.user = { id: "user-1", email: "max@lizo.ai" };
    await renderJoin("tok-1");

    const form = screen.getByTestId("join-form");
    expect(form).toHaveAttribute("data-token", "tok-1");
    expect(form).toHaveAttribute("data-org", "Lizo");
    expect(state.redirectedTo).toBeNull();
  });

  it("matches the invitee's address case-insensitively", async () => {
    state.session = { id: "ext-1", email: "Max@Lizo.AI" };
    state.user = { id: "user-1", email: "Max@Lizo.AI" };
    await renderJoin("tok-1");

    expect(screen.getByTestId("join-form")).toBeInTheDocument();
    expect(screen.queryByTestId("join-wrong-account")).toBeNull();
  });

  it("signed in as someone else: the switch-account screen, invitee masked", async () => {
    state.session = { id: "ext-2", email: "other@acme.test" };
    state.user = { id: "user-2", email: "other@acme.test" };
    await renderJoin("tok-1");

    const card = screen.getByTestId("join-wrong-account");
    expect(card).toHaveAttribute("data-org", "Lizo");
    // Enough to recognise, not enough to harvest: the holder of this link is
    // by definition NOT the invitee, so the full address stays out.
    expect(card).toHaveAttribute("data-invited", "m***@lizo.ai");
    expect(card).toHaveAttribute("data-current", "other@acme.test");
    // The very URL to come back to after switching accounts.
    expect(card).toHaveAttribute("data-callback", "/join?token=tok-1");
    expect(screen.queryByTestId("join-form")).toBeNull();
  });

  it("compares the DB row's address, not the session claim, when both exist", async () => {
    // The accept route checks `user.email` from the DB; the screen must
    // agree with the route or it would offer a Join that then bounces.
    state.session = { id: "ext-1", email: "max@lizo.ai" };
    state.user = { id: "user-1", email: "renamed@lizo.ai" };
    await renderJoin("tok-1");

    expect(screen.getByTestId("join-wrong-account")).toHaveAttribute(
      "data-current",
      "renamed@lizo.ai",
    );
  });

  it("falls back to the session's address when the user row is missing", async () => {
    state.session = { id: "ext-2", email: "other@acme.test" };
    state.user = null;
    await renderJoin("tok-1");

    expect(screen.getByTestId("join-wrong-account")).toHaveAttribute(
      "data-current",
      "other@acme.test",
    );
  });

  it("URL-encodes the token it carries into the switch and signup URLs", async () => {
    state.pending = invited;
    await renderJoin("a b&c");
    expect(state.redirectedTo).toBe("/auth/signup?token=a%20b%26c");

    state.redirectedTo = null;
    state.session = { id: "ext-2", email: "other@acme.test" };
    state.user = { id: "user-2", email: "other@acme.test" };
    cleanup();
    await renderJoin("a b&c");
    expect(screen.getByTestId("join-wrong-account")).toHaveAttribute(
      "data-callback",
      "/join?token=a%20b%26c",
    );
  });
});

describe("/join — no token at all", () => {
  it("signed out: to sign in", async () => {
    await renderJoin(undefined);
    expect(state.redirectedTo).toBe("/auth/login");
  });

  it("signed in: to the dashboard", async () => {
    state.session = { id: "ext-1", email: "max@lizo.ai" };
    await renderJoin(undefined);
    expect(state.redirectedTo).toBe("/");
  });
});
