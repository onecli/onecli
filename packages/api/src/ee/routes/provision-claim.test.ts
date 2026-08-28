import { Hono } from "hono";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { initEntitlementForTests } from "../../lib/entitlements";
import type { ApiEnv } from "../../types";
import { ServiceError } from "../../services/errors";
import { errorHandler } from "../../middleware/error-handler";

// POST /v1/provisions/claim is sessioned but deliberately org-less (the
// claimer is not a member yet). This suite pins the boundary behavior: an
// unauthenticated caller is refused, the service's own refusals surface as
// readable 400s, anything else stays a 500 with no internals leaked, and the
// audit row names the JOINED org without the token.

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  user: null as { id: string; email: string } | null,
  claimArgs: null as unknown[] | null,
  claimError: null as Error | null,
  audits: [] as Record<string, unknown>[],
}));

vi.mock("../../providers", () => ({
  getSessionProvider: () => ({
    getSession: async () => state.session,
  }),
}));

vi.mock("@onecli/db", () => ({
  db: {
    user: {
      findUnique: async () => state.user,
    },
  },
}));

vi.mock("../services/user-provision-service", () => ({
  claimProvision: async (...args: unknown[]) => {
    if (state.claimError) throw state.claimError;
    state.claimArgs = args;
    return { organizationId: "org-1", organizationName: "Acme" };
  },
}));

vi.mock("../../services/audit-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/audit-service")>();
  return {
    ...actual,
    withAudit: async (
      op: () => Promise<unknown>,
      params: (r: unknown) => Record<string, unknown>,
    ) => {
      const result = await op();
      state.audits.push(params(result));
      return result;
    },
  };
});

import { provisionClaimRoutes } from "./provision-claim";

const app = new Hono<ApiEnv>()
  .route("/provisions", provisionClaimRoutes())
  .onError(errorHandler);

const claim = (body?: BodyInit) =>
  app.request("/provisions/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

const SESSION = { id: "sub-1", email: "claimer@acme.com" };
const USER = { id: "user-1", email: "claimer@acme.com" };

beforeEach(() => {
  state.session = null;
  state.user = null;
  state.claimArgs = null;
  state.claimError = null;
  state.audits = [];
});

// Licensed feature — run entitled; the unlicensed 403 is proven by
// licensing/enterprise-lock.test.ts.
beforeAll(() => initEntitlementForTests(true));
afterAll(() => initEntitlementForTests(null));

describe("POST /provisions/claim", () => {
  it("refuses without a session, and with a session that maps to no user", async () => {
    expect((await claim(JSON.stringify({ token: "tok" }))).status).toBe(401);

    state.session = SESSION;
    state.user = null;
    expect((await claim(JSON.stringify({ token: "tok" }))).status).toBe(401);
    expect(state.claimArgs).toBeNull();
  });

  it("claims for the sessioned user and answers with the joined org", async () => {
    state.session = SESSION;
    state.user = USER;

    const res = await claim(JSON.stringify({ token: "tok-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: "org-1",
      organizationName: "Acme",
    });
    // The service receives the CALLER's identity — token names the org,
    // session names the person.
    expect(state.claimArgs).toEqual([
      "tok-1",
      "user-1",
      "claimer@acme.com",
      "sub-1",
    ]);
  });

  it("400s on a missing token and on a malformed body — never a 500", async () => {
    state.session = SESSION;
    state.user = USER;

    expect((await claim(JSON.stringify({}))).status).toBe(400);
    expect((await claim("not json at all")).status).toBe(400);
    expect(state.claimArgs).toBeNull();
  });

  it("surfaces the service's own refusals as readable 400s", async () => {
    state.session = SESSION;
    state.user = USER;
    state.claimError = new ServiceError("NOT_FOUND", "Invalid claim link");

    const res = await claim(JSON.stringify({ token: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid claim link" });
  });

  it("keeps faults as 500s without echoing internals", async () => {
    state.session = SESSION;
    state.user = USER;
    state.claimError = new Error(
      'relation "user_provisions" column secret_details does not exist',
    );

    const res = await claim(JSON.stringify({ token: "tok" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret_details");
  });

  it("audits the claim against the joined org, without the token", async () => {
    state.session = SESSION;
    state.user = USER;
    await claim(JSON.stringify({ token: "tok-secret" }));

    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0]!;
    expect(audit).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      action: "accept",
      service: "provision",
      source: "api",
    });
    expect(JSON.stringify(audit)).not.toContain("tok-secret");
  });
});
