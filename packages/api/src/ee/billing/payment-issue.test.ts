import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// Plan resolution is unit-tested in subscription-plan.test.ts; pin it so these
// tests read the status/ownership logic, not the env-built price map.
vi.mock("./subscription-plan", () => ({
  resolveSubscriptionPlan: () => ({ plan: "pro", baseItem: undefined }),
}));

import { ENDED_BANNER_WINDOW_MS, findOrgPaymentIssue } from "./payment-issue";

const NOW = Date.UTC(2026, 8, 27);
const sec = (ms: number) => Math.floor(ms / 1000);

const openInvoice = {
  status: "open",
  hosted_invoice_url: "https://invoice.stripe.com/i/test",
  amount_remaining: 1250,
};

const sub = (overrides: Record<string, unknown>) =>
  ({
    id: "sub_1",
    status: "active",
    created: sec(NOW) - 1000,
    metadata: { organizationId: "org-1" },
    latest_invoice: null,
    cancellation_details: null,
    ended_at: null,
    ...overrides,
  }) as unknown as Stripe.Subscription;

const stripeWith = ({
  listed = [] as Stripe.Subscription[],
  searched = [] as Stripe.Subscription[],
  searchThrows = false,
} = {}) => {
  const list = vi.fn(async () => ({ data: listed }));
  const search = vi.fn(async () => {
    if (searchThrows) throw new Error("search unavailable");
    return { data: searched };
  });
  return {
    stripe: { subscriptions: { list, search } } as unknown as Stripe,
    list,
    search,
  };
};

describe("findOrgPaymentIssue", () => {
  it("returns null for a healthy active subscription", async () => {
    const { stripe, search } = stripeWith({
      listed: [sub({ status: "active" })],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
    // Hot path (every dashboard load): no rate-limited search call.
    expect(search).not.toHaveBeenCalled();
  });

  it("reports past_due with the open invoice's hosted pay link", async () => {
    const { stripe, list } = stripeWith({
      listed: [sub({ status: "past_due", latest_invoice: openInvoice })],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toEqual({
      kind: "past_due",
      plan: "pro",
      planName: "Pro",
      amountDue: 1250,
      invoiceUrl: "https://invoice.stripe.com/i/test",
    });
    // Must list every status, or past_due/canceled subs are invisible.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1", status: "all" }),
    );
  });

  it("treats unpaid like past_due", async () => {
    const { stripe } = stripeWith({
      listed: [sub({ status: "unpaid", latest_invoice: openInvoice })],
    });
    expect(
      (await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW))?.kind,
    ).toBe("past_due");
  });

  it("returns null for past_due without a payable open invoice", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "past_due",
          latest_invoice: { ...openInvoice, status: "paid" },
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("never emits a non-https invoice link", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "past_due",
          latest_invoice: {
            ...openInvoice,
            hosted_invoice_url: "javascript:alert(1)",
          },
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("stays silent when another live subscription covers the org", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({ id: "sub_old", status: "past_due", latest_invoice: openInvoice }),
        sub({ id: "sub_new", status: "active" }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("never surfaces another org's subscription on a shared customer", async () => {
    // Security fence: an invoice link for org-2 must not reach org-1's admins.
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "past_due",
          latest_invoice: openInvoice,
          metadata: { organizationId: "org-2" },
        }),
      ],
      searched: [
        sub({
          id: "sub_x",
          status: "past_due",
          latest_invoice: openInvoice,
          metadata: { organizationId: "org-2" },
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("accepts an unlabeled subscription on the org's own stored customer", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({ status: "past_due", latest_invoice: openInvoice, metadata: {} }),
      ],
    });
    expect(
      (await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW))?.kind,
    ).toBe("past_due");
  });

  it("finds a labeled past_due sub on a drifted customer via search", async () => {
    const { stripe } = stripeWith({
      listed: [],
      searched: [sub({ status: "past_due", latest_invoice: openInvoice })],
    });
    expect(
      (await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW))?.kind,
    ).toBe("past_due");
  });

  it("degrades to the stored-customer answer when search throws", async () => {
    const { stripe } = stripeWith({
      listed: [sub({ status: "past_due", latest_invoice: openInvoice })],
      searchThrows: true,
    });
    expect(
      (await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW))?.kind,
    ).toBe("past_due");
  });

  it("does not query search with an unsafe org id", async () => {
    const { stripe, search } = stripeWith();
    await findOrgPaymentIssue(stripe, "org' OR 'x", null, NOW);
    expect(search).not.toHaveBeenCalled();
  });

  it("reports ended when Stripe canceled the newest sub for non-payment", async () => {
    const endedAt = sec(NOW - 24 * 60 * 60 * 1000);
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "canceled",
          cancellation_details: { reason: "payment_failed" },
          ended_at: endedAt,
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toEqual({
      kind: "ended",
      plan: "pro",
      planName: "Pro",
      endedAt: new Date(endedAt * 1000).toISOString(),
    });
  });

  it("ignores a payment-failure cancel older than the window", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "canceled",
          cancellation_details: { reason: "payment_failed" },
          ended_at: sec(NOW - ENDED_BANNER_WINDOW_MS - 60_000),
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("ignores a deliberate cancellation", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({
          status: "canceled",
          cancellation_details: { reason: "cancellation_requested" },
          ended_at: sec(NOW - 60_000),
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });

  it("only the newest subscription decides ended", async () => {
    const { stripe } = stripeWith({
      listed: [
        sub({
          id: "sub_old",
          created: sec(NOW) - 5000,
          status: "canceled",
          cancellation_details: { reason: "payment_failed" },
          ended_at: sec(NOW - 60_000),
        }),
        sub({
          id: "sub_new",
          created: sec(NOW) - 100,
          status: "canceled",
          cancellation_details: { reason: "cancellation_requested" },
          ended_at: sec(NOW - 30_000),
        }),
      ],
    });
    expect(await findOrgPaymentIssue(stripe, "org-1", "cus_1", NOW)).toBeNull();
  });
});
