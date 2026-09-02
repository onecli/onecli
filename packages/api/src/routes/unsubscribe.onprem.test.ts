import { describe, expect, it, vi } from "vitest";

// ── Unsubscribe survives the EE /webhooks wildcard on a self-host ───────────
//
// A composition test, not a router test, because the hazard only exists in the
// assembled app: the FREE unsubscribe route is mounted at
// `/webhooks/unsubscribe` (app.ts) while the hosted-platform Resend intake
// mounts a `cloudOnly` wildcard over `/webhooks/*` (ee/index.ts). Registration
// order is the only thing keeping the wildcard from swallowing unsubscribe —
// and if it ever did, EVERY self-host's unsubscribe links would 404 while the
// unit tests for both routers stayed green.
//
// Pinned to the self-host lane: that is where the wildcard refuses.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
  process.env.OAUTH_STATE_SECRET ??= "test-secret";
  process.env.UNSUBSCRIBE_TOKEN_SECRET = "composition-test-secret";
});

const store = vi.hoisted(() => ({ unsubscribed: [] as string[] }));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    resendBadEmail: {
      findFirst: async () => null,
      create: async (args: { data: { email: string } }) => {
        store.unsubscribed.push(args.data.email);
        return args.data;
      },
    },
    resendWebhook: { findMany: async () => [] },
  },
}));

const { createApiApp } = await import("../app");
const { createUnsubscribeToken } =
  await import("../services/unsubscribe-token");

const app = createApiApp({ getSession: async () => null });

describe("the free unsubscribe route inside the real app (self-host)", () => {
  it("is NOT swallowed by the EE /webhooks wildcard", async () => {
    const token = createUnsubscribeToken("victim@example.com");
    expect(token).not.toBeNull();

    const res = await app.request(`/v1/webhooks/unsubscribe?token=${token}`, {
      method: "POST",
    });

    // The wildcard's refusal shape is a 404 `invalid_request_error`; anything
    // but that means unsubscribe kept its route.
    expect(res.status).toBe(200);
    expect(store.unsubscribed).toEqual(["victim@example.com"]);
  });

  it("the sibling EE intake IS dark here — the wildcard does apply to its own paths", async () => {
    // The positive control: without this, the test above could pass because
    // the wildcard was never mounted at all.
    const res = await app.request("/v1/webhooks/resend", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });
});
