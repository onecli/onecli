// @vitest-environment jsdom
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── /join over REAL PostgreSQL ──────────────────────────────────────────────
//
// The mocked page suite (join-page.onprem.test.tsx) proves the branching over
// a hand-rolled model of the invitation service. This suite runs the REAL
// page against REAL rows — the real `findPendingInvitationByToken`,
// `findAcceptedInvitationOrgForUser`, `explainUnavailableInvitation`, and the
// real `db.user` lookup — with only the session stubbed. It is the closest a
// test gets to a person clicking a join link: the token is a real 64-hex
// bearer written by `createInvitation`, the accept is the real transaction,
// and the page has to come to the right screen from the rows alone.
//
// Env-gated like the api package's proof suites (`packages/api/src/testing/
// pg-proof.ts`, whose gate is mirrored here because `testing/*` is not part of
// the package's export map): skip locally when no database is configured, but
// FAIL in CI, where a silently skipped suite reports the same green as a
// passing one.

const proofDatabaseUrl = (): string | undefined => {
  const url = process.env.POLICY_PROOF_DATABASE_URL;
  if (url !== undefined && url !== "") return url;
  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new Error(
      "POLICY_PROOF_DATABASE_URL must be set in CI: the pg proof suites must " +
        "not silently skip.",
    );
  }
  return undefined;
};

const PROOF_URL = proofDatabaseUrl();

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const url = process.env.POLICY_PROOF_DATABASE_URL;
  if (url) process.env.DATABASE_URL = url;
});

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  redirectedTo: null as string | null,
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => state.session,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirectedTo = url;
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

// The client screens need the auth/router providers the page does not mount;
// stub them to their props so this suite asserts on WHICH screen, with WHAT.
vi.mock("./_components/join-form", () => ({
  JoinForm: ({ token, orgName }: { token: string; orgName: string }) => (
    <div data-testid="join-form" data-token={token} data-org={orgName} />
  ),
}));
vi.mock("./_components/join-wrong-account", () => ({
  JoinWrongAccount: (p: {
    orgName: string;
    invitedEmail: string;
    currentEmail: string;
  }) => (
    <div
      data-testid="join-wrong-account"
      data-org={p.orgName}
      data-invited={p.invitedEmail}
      data-current={p.currentEmail}
    />
  ),
}));
vi.mock("./_components/join-resume-sign-in", () => ({
  JoinResumeSignIn: ({ callbackUrl }: { callbackUrl: string }) => (
    <button data-testid="resume-sign-in" data-callback={callbackUrl} />
  ),
}));

type Db = typeof import("@onecli/db").db;
type Service = typeof import("@onecli/api/services/invitation-service");

let db: Db;
let svc: Service;
let JoinPage: typeof import("./join-page").default;

const P = "joinpage-proof-";
const ORG = `${P}org`;
const ORG_NAME = "Join Page Proof Org";
const OWNER = `${P}owner`;
const INVITEE = `${P}invitee`;
const STRANGER = `${P}stranger`;
const email = (who: string) => `${who}@example.com`;
const signInAs = (who: string) => {
  state.session = { id: `${who}-auth`, email: email(who) };
};

const renderJoin = async (token: string) => {
  state.redirectedTo = null;
  try {
    render(await JoinPage({ searchParams: Promise.resolve({ token }) }));
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "NEXT_REDIRECT") throw err;
  }
};

describe.skipIf(!PROOF_URL)("/join over real PostgreSQL", () => {
  beforeAll(async () => {
    ({ db } = await import("@onecli/db"));
    svc = await import("@onecli/api/services/invitation-service");
    ({ default: JoinPage } = await import("./join-page"));
  });

  const purge = async () => {
    const workspaces = await db.workspace.findMany({
      where: { organizationId: ORG },
      select: { id: true },
    });
    const ids = workspaces.map((w) => w.id);
    await db.agent.deleteMany({ where: { workspaceId: { in: ids } } });
    await db.apiKey.deleteMany({ where: { workspaceId: { in: ids } } });
    await db.policyRuleV2.deleteMany({ where: { workspaceId: { in: ids } } });
    await db.workspaceAccess.deleteMany({
      where: { workspaceId: { in: ids } },
    });
    await db.workspace.deleteMany({ where: { id: { in: ids } } });
    await db.invitation.deleteMany({ where: { organizationId: ORG } });
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await db.user.deleteMany({
      where: { id: { in: [OWNER, INVITEE, STRANGER] } },
    });
  };

  beforeEach(async () => {
    state.session = null;
    state.redirectedTo = null;
    cleanup();
    await purge();
    for (const who of [OWNER, INVITEE, STRANGER]) {
      await db.user.create({
        data: { id: who, email: email(who), externalAuthId: `${who}-auth` },
      });
    }
    await db.organization.create({
      data: {
        id: ORG,
        name: ORG_NAME,
        slug: `${P}slug`,
        members: {
          create: { userId: OWNER, userEmail: email(OWNER), role: "owner" },
        },
      },
    });
  });

  afterAll(async () => {
    if (db) await purge();
  });

  const invite = () =>
    svc.createInvitation({
      organizationId: ORG,
      email: email(INVITEE),
      role: "member",
      invitedById: OWNER,
      invitedByEmail: email(OWNER),
    });

  it("the invitee, signed in: the join form for THIS org", async () => {
    const { token } = await invite();
    signInAs(INVITEE);
    await renderJoin(token);

    const form = screen.getByTestId("join-form");
    expect(form).toHaveAttribute("data-token", token);
    expect(form).toHaveAttribute("data-org", ORG_NAME);
  });

  it("a stranger, signed in: the switch screen, invitee masked from the real row", async () => {
    const { token } = await invite();
    signInAs(STRANGER);
    await renderJoin(token);

    const card = screen.getByTestId("join-wrong-account");
    expect(card).toHaveAttribute("data-org", ORG_NAME);
    expect(card).toHaveAttribute("data-invited", "j***@example.com");
    expect(card).toHaveAttribute("data-current", email(STRANGER));
    // The full invitee address is nowhere in the rendered document.
    expect(document.body.innerHTML).not.toContain(email(INVITEE));
  });

  it("signed out on self-host: to signup with the real token", async () => {
    const { token } = await invite();
    await renderJoin(token);
    expect(state.redirectedTo).toBe(`/auth/signup?token=${token}`);
  });

  it("after the real accept: the accepter's re-click goes INTO the org", async () => {
    const { token } = await invite();
    await svc.acceptInvitation(token, INVITEE, email(INVITEE), null);

    signInAs(INVITEE);
    await renderJoin(token);
    expect(state.redirectedTo).toBe(`/org/${ORG}/workspaces`);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("after the real accept: a stranger's click says 'already used', no org name, no way in", async () => {
    const { token } = await invite();
    await svc.acceptInvitation(token, INVITEE, email(INVITEE), null);

    signInAs(STRANGER);
    await renderJoin(token);
    expect(state.redirectedTo).toBeNull();
    expect(
      screen.getByRole("heading", { name: /already used/i }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(ORG_NAME);
    expect(document.body.innerHTML).not.toContain(email(INVITEE));
    // Signed in: the plain dashboard link, not the resume button.
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByTestId("resume-sign-in")).toBeNull();
  });

  it("after the real accept, signed OUT: 'already used' with the way back to this link", async () => {
    const { token } = await invite();
    await svc.acceptInvitation(token, INVITEE, email(INVITEE), null);

    await renderJoin(token);
    expect(state.redirectedTo).toBeNull();
    expect(
      screen.getByRole("heading", { name: /already used/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("resume-sign-in")).toHaveAttribute(
      "data-callback",
      `/join?token=${token}`,
    );
  });

  it("after the accepter is removed: their own re-click reads 'already used' instead of redirecting into a bounce", async () => {
    const { token } = await invite();
    await svc.acceptInvitation(token, INVITEE, email(INVITEE), null);
    await db.organizationMember.delete({
      where: {
        organizationId_userId: { organizationId: ORG, userId: INVITEE },
      },
    });

    signInAs(INVITEE);
    await renderJoin(token);
    expect(state.redirectedTo).toBeNull();
    expect(
      screen.getByRole("heading", { name: /already used/i }),
    ).toBeInTheDocument();
  });

  it("cancelled, expired-without-stamp, and unknown: each named, signed in or out", async () => {
    const first = await invite();
    await svc.cancelInvitation(ORG, first.id);
    await renderJoin(first.token);
    expect(
      screen.getByRole("heading", { name: /was cancelled/i }),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(ORG_NAME);

    cleanup();
    const second = await invite();
    await db.invitation.update({
      where: { id: second.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    signInAs(INVITEE);
    await renderJoin(second.token);
    expect(state.redirectedTo).toBeNull();
    expect(
      screen.getByRole("heading", { name: /has expired/i }),
    ).toBeInTheDocument();

    cleanup();
    await renderJoin("not-a-real-token");
    expect(
      screen.getByRole("heading", { name: /isn't valid/i }),
    ).toBeInTheDocument();
  });
});
