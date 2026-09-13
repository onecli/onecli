import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// The webhook is the source of truth for subscriptionStatus. These tests drive
// the real route with Stripe + the DB mocked, and assert the write behavior of
// customer.subscription.updated (immediate plan reconcile) and .deleted
// (downgrade to free). Plan *resolution* is unit-tested in
// subscription-plan.test.ts; here it's stubbed so assertions read the status
// gating, not the price map.

// The router is edition-dark off cloud and `IS_CLOUD` freezes at module load,
// so pin cloud before the graph loads — this file tests the in-cloud
// signature/config behavior.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

const state = vi.hoisted(() => ({
  updateManyCalls: [] as Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>,
  retrieveSub: null as { status: string } | null,
  /** Per-id retrieve responses (falls back to retrieveSub). */
  retrieveSubById: {} as Record<string, unknown>,
  retrieveThrows: false,
  /** Ordered log of subscription update/cancel calls. */
  subscriptionOps: [] as string[],
  subscriptionUpdates: [] as Array<{ id: string; params: unknown }>,
  /** Subscriptions returned by subscriptions.list (any customer). */
  listSubs: [] as unknown[],
  /** Per-customer list responses (wins over listSubs when the key exists). */
  listSubsByCustomer: {} as Record<string, unknown[]>,
  listThrows: false,
  /** Subscriptions returned by subscriptions.search (org-metadata backstop). */
  searchSubs: [] as unknown[],
  /** The org row's stored Stripe customer (deleted-handler lookup scope). */
  orgStripeCustomerId: "cus_1" as string | null,
}));

vi.mock("@onecli/db", () => ({
  db: {
    organization: {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        state.updateManyCalls.push(args);
        return { count: 1 };
      },
      findUnique: async () => ({
        stripeCustomerId: state.orgStripeCustomerId,
      }),
    },
  },
}));

vi.mock("../billing/stripe", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (body: string) => JSON.parse(body) },
    subscriptions: {
      retrieve: async (id: string) => {
        if (state.retrieveThrows) throw new Error("stripe unavailable");
        return (state.retrieveSubById[id] ??
          state.retrieveSub) as unknown as Stripe.Subscription;
      },
      update: async (id: string, params: unknown) => {
        state.subscriptionOps.push(`update:${id}`);
        state.subscriptionUpdates.push({ id, params });
        return {} as Stripe.Subscription;
      },
      cancel: async (id: string) => {
        state.subscriptionOps.push(`cancel:${id}`);
        return {} as Stripe.Subscription;
      },
      list: async ({ customer }: { customer?: string } = {}) => {
        if (state.listThrows) throw new Error("stripe unavailable");
        if (customer && customer in state.listSubsByCustomer) {
          return { data: state.listSubsByCustomer[customer] };
        }
        return { data: state.listSubs };
      },
      search: async () => ({ data: state.searchSubs }),
    },
    customers: {
      retrieve: async () => ({
        deleted: false,
        email: "owner@acme.com",
        address: { country: "US" },
      }),
    },
  }),
}));

// Keep the real env module but force a configured webhook secret so the handler
// gets past its "not configured" guard.
vi.mock("../billing/env", async (importActual) => ({
  ...(await importActual<typeof import("../billing/env")>()),
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

// Decouple the route test from the env-built price map: a live sub resolves to
// a fixed plan so we can assert the exact status written.
vi.mock("../billing/subscription-plan", () => ({
  resolveSubscriptionPlan: () => ({ plan: "team", baseItem: undefined }),
}));

vi.mock("../notifications/discord", () => ({ notifyDiscord: vi.fn() }));

import { notifyDiscord } from "../notifications/discord";
import { stripeWebhookRoutes } from "./stripe-webhooks";

const app = stripeWebhookRoutes();

const post = (event: unknown) =>
  app.request("/", {
    method: "POST",
    headers: {
      "stripe-signature": "sig",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const updatedEvent = (
  object: Record<string, unknown>,
): Record<string, unknown> => ({
  type: "customer.subscription.updated",
  data: { object },
});

beforeEach(() => {
  state.updateManyCalls = [];
  state.retrieveSub = null;
  state.retrieveSubById = {};
  state.retrieveThrows = false;
  state.subscriptionOps = [];
  state.subscriptionUpdates = [];
  state.listSubs = [];
  state.listSubsByCustomer = {};
  state.listThrows = false;
  state.searchSubs = [];
  state.orgStripeCustomerId = "cus_1";
  vi.mocked(notifyDiscord).mockClear();
});

describe("customer.subscription.updated", () => {
  it("writes the org's current plan when the live subscription is active", async () => {
    state.retrieveSub = { status: "active" };
    const res = await post(
      updatedEvent({
        id: "sub_1",
        metadata: { organizationId: "org-1" },
        cancel_at_period_end: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "team" },
      },
    ]);
  });

  it("writes the plan for a trialing subscription", async () => {
    state.retrieveSub = { status: "trialing" };
    const res = await post(
      updatedEvent({
        id: "sub_1",
        metadata: { organizationId: "org-1" },
        cancel_at_period_end: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(1);
    expect(state.updateManyCalls[0]!.data.subscriptionStatus).toBe("team");
  });

  it("does NOT change the plan while a payment is retrying (past_due)", async () => {
    // Dunning is non-terminal: hold the current plan and let retries resolve.
    state.retrieveSub = { status: "past_due" };
    const res = await post(
      updatedEvent({
        id: "sub_1",
        metadata: { organizationId: "org-1" },
        cancel_at_period_end: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(0);
  });

  it("does NOT re-provision when a stale update arrives after cancellation", async () => {
    // The event payload can look active, but webhooks are unordered — we act on
    // the freshly retrieved sub, which is already canceled.
    state.retrieveSub = { status: "canceled" };
    const res = await post(
      updatedEvent({
        id: "sub_1",
        status: "active",
        metadata: { organizationId: "org-1" },
        cancel_at_period_end: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(0);
  });

  it("skips reconcile when the subscription has no organizationId", async () => {
    state.retrieveSub = { status: "active" };
    const res = await post(
      updatedEvent({ id: "sub_1", metadata: {}, cancel_at_period_end: false }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(0);
  });

  it("acks (200) and does not write when the refetch fails", async () => {
    // A transient Stripe error must not fail the webhook — Stripe would retry.
    state.retrieveThrows = true;
    const res = await post(
      updatedEvent({
        id: "sub_1",
        metadata: { organizationId: "org-1" },
        cancel_at_period_end: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(0);
  });
});

describe("checkout.session.completed: superseded trial", () => {
  const completedEvent = (subscriptionId: string) => ({
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: subscriptionId,
        customer_details: { address: { country: "US" } },
      },
    },
  });

  const newSub = (supersedes: string) => ({
    id: "sub_new",
    status: "active",
    metadata: {
      organizationId: "org-1",
      supersedesSubscription: supersedes,
    },
  });

  it("marks the old trial superseded, then cancels it", async () => {
    state.retrieveSubById = {
      sub_new: newSub("sub_old"),
      sub_old: {
        id: "sub_old",
        status: "trialing",
        metadata: { organizationId: "org-1" },
      },
    };

    const res = await post(completedEvent("sub_new"));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "team" },
      },
    ]);
    // supersededBy must land BEFORE the cancel so the deletion event always
    // carries the conversion marker (webhooks are unordered).
    expect(state.subscriptionOps).toEqual(["update:sub_old", "cancel:sub_old"]);
    expect(state.subscriptionUpdates).toEqual([
      { id: "sub_old", params: { metadata: { supersededBy: "sub_new" } } },
    ]);
  });

  it("does not cancel an already-terminal old subscription (redelivery)", async () => {
    state.retrieveSubById = {
      sub_new: newSub("sub_old"),
      sub_old: {
        id: "sub_old",
        status: "canceled",
        metadata: { organizationId: "org-1" },
      },
    };

    const res = await post(completedEvent("sub_new"));

    expect(res.status).toBe(200);
    expect(state.subscriptionOps).toEqual([]);
  });

  it("does not cancel a subscription belonging to another org", async () => {
    state.retrieveSubById = {
      sub_new: newSub("sub_other"),
      sub_other: {
        id: "sub_other",
        status: "trialing",
        metadata: { organizationId: "org-2" },
      },
    };

    const res = await post(completedEvent("sub_new"));

    expect(res.status).toBe(200);
    expect(state.subscriptionOps).toEqual([]);
  });
});

describe("checkout.session.completed: customer adoption", () => {
  // The drift at its source: Checkout can bill a different customer than the
  // org row stores (converted card-less trial, payment link with
  // customer_creation "if_required"). The webhook is the one moment Stripe
  // says which customer won — the org must adopt it, or every later
  // reconcile-on-read lists an empty customer and downgrades the org.
  it("repoints the org at the subscription's customer", async () => {
    state.retrieveSubById = {
      sub_new: {
        id: "sub_new",
        status: "active",
        customer: "cus_winner",
        metadata: { organizationId: "org-1" },
      },
    };

    const res = await post({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          subscription: "sub_new",
          customer_details: { address: { country: "US" } },
        },
      },
    });

    expect(res.status).toBe(200);
    const adopt = state.updateManyCalls.find(
      (c) => "stripeCustomerId" in c.data,
    );
    expect(adopt?.data).toEqual({ stripeCustomerId: "cus_winner" });
    // The where must reach rows whose stripeCustomerId is NULL: an org whose
    // first payment came through a payment link never stored a customer at
    // all, and Prisma's NOT-equals silently skips NULL rows.
    expect(adopt?.where).toEqual({
      id: "org-1",
      OR: [
        { stripeCustomerId: null },
        { NOT: { stripeCustomerId: "cus_winner" } },
      ],
    });
  });
});

describe("customer.subscription.deleted", () => {
  const deletedEvent = (
    metadata: Record<string, string>,
  ): Record<string, unknown> => ({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_1",
        status: "canceled",
        customer: "cus_1",
        metadata,
        latest_invoice: null,
      },
    },
  });

  it("downgrades the org to free and notifies churn", async () => {
    const res = await post(deletedEvent({ organizationId: "org-1" }));
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "free" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledTimes(1);
  });

  it("skips the downgrade and churn for a superseded trial", async () => {
    // The completed handler already applied the paid plan; this deletion is
    // a conversion, not churn.
    const res = await post(
      deletedEvent({ organizationId: "org-1", supersededBy: "sub_new" }),
    );
    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toHaveLength(0);
    expect(vi.mocked(notifyDiscord)).not.toHaveBeenCalled();
  });

  it("applies the remaining live subscription's plan instead of free", async () => {
    state.listSubs = [
      {
        id: "sub_live",
        status: "active",
        metadata: { organizationId: "org-1" },
      },
    ];

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "team" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).not.toHaveBeenCalled();
  });

  it("keeps the plan of a live subscription on a DIFFERENT customer", async () => {
    // The drift scenario: the deleted sub's customer holds nothing, but the
    // org's real subscription sits elsewhere — found via the org-metadata
    // search, and the org adopts its customer id.
    state.searchSubs = [
      {
        id: "sub_live",
        status: "active",
        customer: "cus_other",
        metadata: { organizationId: "org-1" },
      },
    ];

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(
      state.updateManyCalls.find((c) => "subscriptionStatus" in c.data)?.data,
    ).toEqual({ subscriptionStatus: "team" });
    expect(
      state.updateManyCalls.find((c) => "stripeCustomerId" in c.data)?.data,
    ).toEqual({ stripeCustomerId: "cus_other" });
    expect(vi.mocked(notifyDiscord)).not.toHaveBeenCalled();
  });

  it("still churns to free when the search only echoes the deleted sub", async () => {
    // Stripe's search index is eventually consistent: right after a deletion
    // it can still return the dead subscription as active. Counting it as
    // "remaining" would leave a churned org on its paid plan.
    state.searchSubs = [
      {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        metadata: { organizationId: "org-1" },
      },
    ];

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "free" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledTimes(1);
  });

  it("ignores another org's live subscription on the same customer", async () => {
    state.listSubs = [
      {
        id: "sub_other",
        status: "active",
        metadata: { organizationId: "org-2" },
      },
    ];

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "free" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledTimes(1);
  });

  it("falls back to free and notifies churn when the lookup fails", async () => {
    state.listThrows = true;

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "free" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledTimes(1);
  });

  it("does not adopt an unlabeled sub on the dead sub's customer when the org row points elsewhere", async () => {
    // The metadata-less fallback is legitimate only on the customer the org
    // row uniquely claims (cus_other, empty here). The dead sub's customer
    // (cus_1) can be shared, and its unlabeled dashboard-created sub may
    // belong to someone else — churn must not keep this org paid on the
    // strength of it.
    state.orgStripeCustomerId = "cus_other";
    state.listSubsByCustomer = {
      cus_other: [],
      cus_1: [{ id: "sub_unlabeled", status: "active", metadata: {} }],
    };

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(state.updateManyCalls).toEqual([
      {
        where: { id: "org-1", subscriptionStatus: { not: "aws-marketplace" } },
        data: { subscriptionStatus: "free" },
      },
    ]);
    expect(vi.mocked(notifyDiscord)).toHaveBeenCalledTimes(1);
  });

  it("keeps a labeled sub on the dead sub's customer when the org row is NULL", async () => {
    // Payment-link org whose adoption write raced or failed: the org row has
    // no customer, search is empty (eventual consistency), but the event's
    // customer holds the org's own labeled live subscription.
    state.orgStripeCustomerId = null;
    state.listSubs = [
      {
        id: "sub_live",
        status: "active",
        customer: "cus_1",
        metadata: { organizationId: "org-1" },
      },
    ];

    const res = await post(deletedEvent({ organizationId: "org-1" }));

    expect(res.status).toBe(200);
    expect(
      state.updateManyCalls.find((c) => "subscriptionStatus" in c.data)?.data,
    ).toEqual({ subscriptionStatus: "team" });
    expect(vi.mocked(notifyDiscord)).not.toHaveBeenCalled();
  });
});
