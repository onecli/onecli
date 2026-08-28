import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../providers/types";

// Route-level tests for the identity-conflict seam in GET /auth/session: a
// session whose email belongs to a user with a DIFFERENT externalAuthId is
// decided by the resolveIdentityConflict hook — the default preserves the
// historical always-link behavior; a rejecting hook turns the sign-in into 409.

// Hermetic to the ambient edition (CI runs with NEXT_PUBLIC_EDITION=cloud):
// pin before any import evaluates.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const state = vi.hoisted(() => ({
  session: null as SessionUser | null,
  dbUser: null as {
    id: string;
    email: string;
    externalAuthId: string;
  } | null,
  upserts: [] as Record<string, unknown>[],
  defaultWorkspace: null as { id: string; organizationId: string } | null,
  bootstraps: 0,
  /** Every step that touches identity, in the order it ran. */
  order: [] as string[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { JsonNull: null },
  db: {
    user: {
      findUnique: async () => {
        state.order.push("findUnique");
        return state.dbUser
          ? {
              id: state.dbUser.id,
              email: state.dbUser.email,
              externalAuthId: state.dbUser.externalAuthId,
            }
          : null;
      },
      upsert: async (args: Record<string, unknown>) => {
        state.order.push("upsert");
        state.upserts.push(args);
        return { id: "user-1", email: "guy@acme.com", name: "Guy" };
      },
    },
  },
}));

// The org/workspace side is stateful: the default (proj-1) takes the
// established-user path (no bootstrap); onUserCreated-seam tests null it to
// drive the bootstrap decision.
vi.mock("../services/organization-service", () => ({
  findUserDefaultWorkspace: async () => state.defaultWorkspace,
  ensureUserOrganization: async () => {
    state.bootstraps += 1;
    return {
      workspace: { id: "boot-proj", organizationId: "boot-org" },
      organization: { id: "boot-org" },
      created: true,
    };
  },
  ensureWorkspaceSeeds: async () => {},
}));

import {
  initSession,
  initSessionEnforcer,
  initSessionThrottle,
} from "../providers";
import { authSessionRoutes, initSessionHooks } from "./auth-session";
import type { SessionHooks } from "./auth-session";

initSession({
  getSession: async () => state.session,
});

const app = authSessionRoutes();

beforeEach(() => {
  state.session = null;
  state.dbUser = null;
  state.upserts = [];
  state.defaultWorkspace = { id: "proj-1", organizationId: "org-1" };
  state.bootstraps = 0;
  state.order = [];
});

afterEach(() => {
  // _hooks is module-global — restore the defaults so later suites in the
  // same worker never inherit a rejecting hook.
  initSessionHooks({});
  initSessionEnforcer(null);
  initSessionThrottle(null);
});

describe("GET /auth/session identity-conflict seam", () => {
  it("links on conflict by default (historical behavior, pins OSS)", async () => {
    state.session = { id: "new-sub", email: "guy@acme.com", name: "Guy" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "old-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
  });

  it("returns 409 and skips the upsert when the hook rejects", async () => {
    initSessionHooks({ resolveIdentityConflict: () => "reject" });
    state.session = { id: "evil-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "old-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("different sign-in identity");
    expect(state.upserts).toHaveLength(0);
  });

  it("never consults the hook when the sub matches", async () => {
    let consulted = false;
    initSessionHooks({
      resolveIdentityConflict: () => {
        consulted = true;
        return "reject";
      },
    });
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(consulted).toBe(false);
  });

  it("never consults the hook for a brand-new email", async () => {
    let consulted = false;
    initSessionHooks({
      resolveIdentityConflict: () => {
        consulted = true;
        return "reject";
      },
    });
    state.session = { id: "new-sub", email: "new@acme.com" };
    state.dbUser = null;

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(consulted).toBe(false);
  });
});

describe("GET /auth/session beforeIdentitySync seam", () => {
  it("runs before anything reads a user row", async () => {
    // Placement is the point. The self-hosted upgrade path uses this hook to
    // decide WHICH row the session belongs to, and it does that by rewriting
    // one — so a lookup that ran first would resolve the pre-adoption world
    // and then provision a second, empty organization beside the real data.
    initSessionHooks({
      beforeIdentitySync: async () => {
        state.order.push("beforeIdentitySync");
      },
    });
    state.session = { id: "ba:sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "ba:sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.order).toEqual(["beforeIdentitySync", "findUnique", "upsert"]);
  });

  it("a failure fails the request instead of provisioning around it", async () => {
    // Deliberately NOT best-effort, unlike ensureSessionMembership. Carrying
    // on would bootstrap a fresh organization for an identity whose real data
    // is still attached to another row — a state no later request could
    // repair. A 500 is retryable; that silent split is not.
    initSessionHooks({
      beforeIdentitySync: async () => {
        throw new Error("adoption failed");
      },
    });
    state.session = { id: "ba:sub", email: "guy@acme.com" };
    state.dbUser = null;
    state.defaultWorkspace = null;

    const res = await app.request("/");
    expect(res.status).toBe(500);
    expect(state.bootstraps).toBe(0);
    expect(state.upserts).toHaveLength(0);
  });

  it("the default is a no-op (cloud is unaffected)", async () => {
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.order).toEqual(["findUnique", "upsert"]);
  });
});

describe("GET /auth/session ensureSessionMembership seam", () => {
  it("calls the hook with the session and the upserted user, before workspace resolution", async () => {
    const calls: Array<{ sessionId: string; userId: string }> = [];
    initSessionHooks({
      ensureSessionMembership: async (session, user) => {
        calls.push({ sessionId: session.id, userId: user.id });
      },
    });
    state.session = { id: "sso-sub", email: "guy@acme.com", name: "Guy" };
    state.dbUser = null;

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ sessionId: "sso-sub", userId: "user-1" }]);
  });

  it("default hook is a no-op (existing sessions unaffected)", async () => {
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId?: string };
    expect(body.workspaceId).toBe("proj-1");
  });
});

describe("GET /auth/session onUserCreated seam", () => {
  type CreatedCall = {
    email: string;
    bootstrappedOrg: boolean;
    hasRequest: boolean;
  };

  const recordCreated = (
    calls: CreatedCall[],
    extra: Partial<SessionHooks> = {},
  ) => {
    initSessionHooks({
      ...extra,
      onUserCreated: (user, _attrs, context) => {
        calls.push({
          email: user.email,
          bootstrappedOrg: context.bootstrappedOrg,
          hasRequest: context.request instanceof Request,
        });
      },
    });
  };

  it("fires with bootstrappedOrg=true on the organic path", async () => {
    const calls: CreatedCall[] = [];
    recordCreated(calls);
    state.session = { id: "new-sub", email: "new@acme.com" };
    state.dbUser = null;
    state.defaultWorkspace = null;

    const res = await app.request("/");
    expect(res.status).toBe(200);
    // The upsert mock always returns guy@acme.com — the assertion pins that
    // the hook sees the upserted user, not the session.
    expect(calls).toEqual([
      { email: "guy@acme.com", bootstrappedOrg: true, hasRequest: true },
    ]);
    expect(state.bootstraps).toBe(1);
  });

  it("fires without bootstrap when shouldBootstrapOrg declines", async () => {
    const calls: CreatedCall[] = [];
    recordCreated(calls, { shouldBootstrapOrg: () => false });
    state.session = { id: "new-sub", email: "new@acme.com" };
    state.dbUser = null;
    state.defaultWorkspace = null;

    const res = await app.request("/?fromInvitation=1");
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { email: "guy@acme.com", bootstrappedOrg: false, hasRequest: true },
    ]);
    expect(state.bootstraps).toBe(0);
  });

  it("fires with bootstrappedOrg=false when a workspace already exists (JIT-membership shape)", async () => {
    const calls: CreatedCall[] = [];
    recordCreated(calls);
    state.session = { id: "sso-sub", email: "new@acme.com" };
    state.dbUser = null;
    // defaultWorkspace stays proj-1: created-without-bootstrap still notifies.

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { email: "guy@acme.com", bootstrappedOrg: false, hasRequest: true },
    ]);
    expect(state.bootstraps).toBe(0);
  });

  it("does not bootstrap for an existing user by default (pins cloud)", async () => {
    // Cognito creates no rows of its own, so a user this request did not
    // create already has an organization — bootstrapping again would hand
    // them a second one.
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };
    state.defaultWorkspace = null;

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.bootstraps).toBe(0);
  });

  it("bootstraps an existing user with no organization when the edition opts in", async () => {
    // The self-hosted identity layer creates the user row during sign-in, so
    // by the time this endpoint runs the row always pre-exists. Requiring
    // "this request created it" would mean such a user is NEVER provisioned —
    // and that a signup whose provisioning failed could never be repaired.
    initSessionHooks({ shouldBootstrapOrg: () => true });
    state.session = { id: "ba-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "ba-sub",
    };
    state.defaultWorkspace = null;

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.bootstraps).toBe(1);
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "boot-proj",
    });
  });

  it("never bootstraps twice for a user who already has a workspace", async () => {
    initSessionHooks({ shouldBootstrapOrg: () => true });
    state.session = { id: "ba-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "ba-sub",
    };
    // defaultWorkspace stays proj-1 — the repair must be keyed on the missing
    // organization, not run on every session.

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.bootstraps).toBe(0);
  });

  it("does not fire for an existing user", async () => {
    const calls: CreatedCall[] = [];
    recordCreated(calls);
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("GET /auth/session sessionEnforcer seam", () => {
  it("returns 401 with the denial body when the enforcer rejects (after the upsert/JIT, never a 500)", async () => {
    initSessionEnforcer(async () => ({
      error: "Your organization requires single sign-on.",
      code: "sso_required",
    }));
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("sso_required");
    expect(body.error).toContain("single sign-on");
    // Placement proof: the upsert already ran — enforcement is post-identity,
    // pre-workspace.
    expect(state.upserts).toHaveLength(1);
  });

  it("an allowing enforcer leaves the session untouched", async () => {
    const seen: string[] = [];
    initSessionEnforcer(async (_session, user) => {
      seen.push(user.id);
      return null;
    });
    state.session = { id: "same-sub", email: "guy@acme.com" };
    state.dbUser = {
      id: "user-1",
      email: "guy@acme.com",
      externalAuthId: "same-sub",
    };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["user-1"]);
  });
});

describe("GET /auth/session sessionThrottle seam", () => {
  it("a throttling middleware answers 429 before the session read and every write", async () => {
    initSessionThrottle(async (c) =>
      c.json(
        {
          error: {
            message: "Too many requests. Try again shortly.",
            type: "rate_limit_error",
          },
        },
        429,
      ),
    );
    // A session that WOULD bootstrap: reaching the handler produces a 200 and
    // an upsert (the passing test below) — so an empty write log here proves
    // the refusal happened ahead of the handler, not inside it.
    state.session = { id: "sub-1", email: "guy@acme.com" };

    const res = await app.request("/");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limit_error");
    // MUTATION-TESTED (placement): move the throttle after the handler's
    // session read and these go non-empty.
    expect(state.order).toEqual([]);
    expect(state.upserts).toHaveLength(0);
  });

  it("the default (onprem) throttle is null and requests pass untouched", async () => {
    state.session = { id: "sub-1", email: "guy@acme.com" };

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
  });
});
