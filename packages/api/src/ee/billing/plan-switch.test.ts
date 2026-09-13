import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  buildPlanSwitchItems,
  findOrgLiveSubscription,
  findOrgLiveSubscriptions,
  hasPendingCancellation,
  previewRenewalDate,
  resolveProrationDate,
  summarizeSwitchPreview,
  trialingWithoutPaymentMethod,
} from "./plan-switch";

const PRO_PRICE = "price_pro";
const TEAM_PRICE = "price_team";
const TEAM_YEARLY_PRICE = "price_team_yearly";
const TEAM_LEGACY_PRICE = "price_team_legacy";
const PRO_ADDON_PRICE = "price_pro_addon";
const KNOWN_BASE_PRICES = [
  PRO_PRICE,
  TEAM_PRICE,
  TEAM_YEARLY_PRICE,
  TEAM_LEGACY_PRICE,
] as const;

const subscription = (
  items: { id: string; priceId: string; quantity?: number }[],
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription =>
  ({
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: items.map((item) => ({
        id: item.id,
        price: { id: item.priceId },
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
      })),
    },
    ...overrides,
  }) as unknown as Stripe.Subscription;

describe("buildPlanSwitchItems", () => {
  it("swaps the base item in place and deletes every other item", () => {
    const sub = subscription([
      { id: "si_base", priceId: PRO_PRICE },
      { id: "si_addon", priceId: PRO_ADDON_PRICE },
    ]);

    const items = buildPlanSwitchItems(sub, TEAM_PRICE, KNOWN_BASE_PRICES);

    expect(items).toEqual([
      { id: "si_base", price: TEAM_PRICE, quantity: 1 },
      { id: "si_addon", deleted: true },
    ]);
  });

  it("swaps a grandfathered legacy base in place and drops its stale add-on", () => {
    // Pre-2026 Team sub: $200 base + qty-0 agent add-on left from the
    // metered model. Switching must reuse the base item (keeps the anchor)
    // and delete the unmapped add-on.
    const sub = subscription([
      { id: "si_base", priceId: TEAM_LEGACY_PRICE },
      { id: "si_addon", priceId: "price_team_addon" },
    ]);

    const items = buildPlanSwitchItems(
      sub,
      TEAM_YEARLY_PRICE,
      KNOWN_BASE_PRICES,
    );

    expect(items).toEqual([
      { id: "si_base", price: TEAM_YEARLY_PRICE, quantity: 1 },
      { id: "si_addon", deleted: true },
    ]);
  });

  it("adds a fresh base item when no known base price is present", () => {
    const sub = subscription([{ id: "si_other", priceId: "price_unknown" }]);

    const items = buildPlanSwitchItems(sub, PRO_PRICE, KNOWN_BASE_PRICES);

    expect(items).toEqual([
      { price: PRO_PRICE, quantity: 1 },
      { id: "si_other", deleted: true },
    ]);
  });

  // A negotiated deal is priced by raising the quantity on the STANDARD plan
  // price (Scale × 2 = double seats, double price), which keeps the price id
  // resolvable — an unknown price id falls back to "pro" and downgrades the
  // org. Resetting to 1 here would halve such a customer's bill the first
  // time they switched plan or interval, silently and with no other signal.
  it("carries a negotiated quantity through a plan switch", () => {
    const sub = subscription([
      { id: "si_base", priceId: TEAM_PRICE, quantity: 2 },
    ]);

    const items = buildPlanSwitchItems(sub, PRO_PRICE, KNOWN_BASE_PRICES);

    expect(items).toEqual([{ id: "si_base", price: PRO_PRICE, quantity: 2 }]);
  });

  it("carries a negotiated quantity through a month↔year switch", () => {
    const sub = subscription([
      { id: "si_base", priceId: TEAM_PRICE, quantity: 2 },
      { id: "si_addon", priceId: PRO_ADDON_PRICE },
    ]);

    const items = buildPlanSwitchItems(
      sub,
      TEAM_YEARLY_PRICE,
      KNOWN_BASE_PRICES,
    );

    expect(items).toEqual([
      { id: "si_base", price: TEAM_YEARLY_PRICE, quantity: 2 },
      { id: "si_addon", deleted: true },
    ]);
  });

  it("leaves an ordinary self-serve subscription at quantity 1", () => {
    const sub = subscription([
      { id: "si_base", priceId: PRO_PRICE, quantity: 1 },
    ]);

    const items = buildPlanSwitchItems(sub, TEAM_PRICE, KNOWN_BASE_PRICES);

    expect(items).toEqual([{ id: "si_base", price: TEAM_PRICE, quantity: 1 }]);
  });

  it.each([
    ["missing", undefined],
    ["zero (stale metered item)", 0],
  ])(
    "normalizes a %s quantity to 1 — never a zero-charge base item",
    (_label, quantity) => {
      const sub = subscription([
        { id: "si_base", priceId: PRO_PRICE, quantity },
      ]);

      const items = buildPlanSwitchItems(sub, TEAM_PRICE, KNOWN_BASE_PRICES);

      expect(items).toEqual([
        { id: "si_base", price: TEAM_PRICE, quantity: 1 },
      ]);
    },
  );
});

describe("summarizeSwitchPreview — same-interval proration sum", () => {
  const line = (
    amount: number,
    parent: Stripe.InvoiceLineItem.Parent | null,
  ): Stripe.InvoiceLineItem =>
    ({ amount, parent }) as unknown as Stripe.InvoiceLineItem;

  const prorationParent = (
    kind: "invoice_item_details" | "subscription_item_details",
    proration: boolean,
  ): Stripe.InvoiceLineItem.Parent =>
    ({
      invoice_item_details:
        kind === "invoice_item_details" ? { proration } : null,
      subscription_item_details:
        kind === "subscription_item_details" ? { proration } : null,
    }) as unknown as Stripe.InvoiceLineItem.Parent;

  it("sums only proration lines across both parent shapes", () => {
    const invoice = {
      currency: "usd",
      lines: {
        data: [
          line(-2180, prorationParent("invoice_item_details", true)),
          line(17444, prorationParent("subscription_item_details", true)),
          line(20000, prorationParent("subscription_item_details", false)),
          line(999, null),
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(summarizeSwitchPreview(invoice, false)).toEqual({
      amountDueTodayCents: 15264,
      currency: "usd",
    });
  });

  it("returns zero when there are no proration lines (e.g. trialing)", () => {
    const invoice = {
      currency: "usd",
      lines: {
        data: [
          line(20000, prorationParent("subscription_item_details", false)),
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(summarizeSwitchPreview(invoice, false)).toEqual({
      amountDueTodayCents: 0,
      currency: "usd",
    });
  });
});

describe("summarizeSwitchPreview", () => {
  const invoice = {
    currency: "usd",
    total: 146800,
    lines: {
      data: [
        {
          amount: -2200,
          parent: {
            invoice_item_details: null,
            subscription_item_details: { proration: true },
          },
        },
        {
          amount: 149000,
          parent: {
            invoice_item_details: null,
            subscription_item_details: { proration: false },
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;

  it("uses the invoice total when the cycle restarts (interval switch)", () => {
    expect(summarizeSwitchPreview(invoice, true)).toEqual({
      amountDueTodayCents: 146800,
      currency: "usd",
    });
  });

  it("uses only proration lines when the cycle keeps its anchor", () => {
    expect(summarizeSwitchPreview(invoice, false)).toEqual({
      amountDueTodayCents: -2200,
      currency: "usd",
    });
  });
});

describe("previewRenewalDate", () => {
  const line = (
    amount: number,
    proration: boolean,
    periodEnd: number | undefined,
  ) =>
    ({
      amount,
      period: periodEnd !== undefined ? { end: periodEnd } : undefined,
      parent: {
        invoice_item_details: null,
        subscription_item_details: { proration },
      },
    }) as unknown as Stripe.InvoiceLineItem;

  it("returns the latest non-proration line's period end", () => {
    const invoice = {
      lines: {
        data: [
          line(-2200, true, 1_790_000_000),
          line(149000, false, 1_831_536_000),
        ],
      },
    } as unknown as Stripe.Invoice;

    expect(previewRenewalDate(invoice)).toBe(1_831_536_000);
  });

  it("returns undefined when every line is a proration", () => {
    const invoice = {
      lines: { data: [line(-2200, true, 1_790_000_000)] },
    } as unknown as Stripe.Invoice;

    expect(previewRenewalDate(invoice)).toBeUndefined();
  });
});

describe("hasPendingCancellation", () => {
  it("is false for a clean subscription", () => {
    expect(hasPendingCancellation(subscription([]))).toBe(false);
  });

  it("is true when cancel_at_period_end is set", () => {
    expect(
      hasPendingCancellation(subscription([], { cancel_at_period_end: true })),
    ).toBe(true);
  });

  it("is true when cancel_at is scheduled", () => {
    expect(
      hasPendingCancellation(subscription([], { cancel_at: 1783000000 })),
    ).toBe(true);
  });
});

describe("trialingWithoutPaymentMethod", () => {
  const stripeWith = (
    customer: Record<string, unknown>,
    attachedCount: number,
  ): Stripe =>
    ({
      customers: {
        retrieve: async () => customer,
        listPaymentMethods: async () => ({
          data: Array.from({ length: attachedCount }, (_, i) => ({
            id: `pm_${i}`,
          })),
        }),
      },
    }) as unknown as Stripe;

  const cardlessCustomer = {
    deleted: false,
    invoice_settings: { default_payment_method: null },
    default_source: null,
  };

  const trialSub = (overrides: Partial<Stripe.Subscription> = {}) =>
    subscription([], {
      status: "trialing",
      customer: "cus_1",
      default_payment_method: null,
      ...overrides,
    });

  it("is true for a trialing sub with no payment method anywhere", async () => {
    await expect(
      trialingWithoutPaymentMethod(stripeWith(cardlessCustomer, 0), trialSub()),
    ).resolves.toBe(true);
  });

  it("is false for a non-trialing subscription", async () => {
    await expect(
      trialingWithoutPaymentMethod(
        stripeWith(cardlessCustomer, 0),
        trialSub({ status: "active" }),
      ),
    ).resolves.toBe(false);
  });

  it("is false when the subscription has a default payment method", async () => {
    await expect(
      trialingWithoutPaymentMethod(
        stripeWith(cardlessCustomer, 0),
        trialSub({ default_payment_method: "pm_sub" }),
      ),
    ).resolves.toBe(false);
  });

  it("is false when the customer has a default payment method", async () => {
    await expect(
      trialingWithoutPaymentMethod(
        stripeWith(
          {
            ...cardlessCustomer,
            invoice_settings: { default_payment_method: "pm_cust" },
          },
          0,
        ),
        trialSub(),
      ),
    ).resolves.toBe(false);
  });

  it("is false when the customer has a legacy default source", async () => {
    await expect(
      trialingWithoutPaymentMethod(
        stripeWith({ ...cardlessCustomer, default_source: "card_1" }, 0),
        trialSub(),
      ),
    ).resolves.toBe(false);
  });

  it("is false when a payment method is attached but not default", async () => {
    await expect(
      trialingWithoutPaymentMethod(stripeWith(cardlessCustomer, 1), trialSub()),
    ).resolves.toBe(false);
  });

  it("is true when the customer was deleted", async () => {
    await expect(
      trialingWithoutPaymentMethod(
        stripeWith({ deleted: true }, 0),
        trialSub(),
      ),
    ).resolves.toBe(true);
  });
});

describe("resolveProrationDate", () => {
  const now = 1_800_000_000;

  it("echoes a recent timestamp", () => {
    expect(resolveProrationDate(now - 60, now)).toBe(now - 60);
    expect(resolveProrationDate(now, now)).toBe(now);
  });

  it("rejects future and expired timestamps", () => {
    expect(resolveProrationDate(now + 1, now)).toBeUndefined();
    expect(resolveProrationDate(now - 3601, now)).toBeUndefined();
  });

  it("rejects non-integer input", () => {
    expect(resolveProrationDate(undefined, now)).toBeUndefined();
    expect(resolveProrationDate("123", now)).toBeUndefined();
    expect(resolveProrationDate(now - 0.5, now)).toBeUndefined();
    expect(resolveProrationDate(null, now)).toBeUndefined();
  });
});

describe("findOrgLiveSubscription", () => {
  // The live incident this exists for: Checkout billed a converted trial to a
  // NEW customer, the org row kept pointing at the old (now empty) customer,
  // and every reconcile-on-read then wrote the paying org back to "free".
  const live = (id: string, customer: string, organizationId: string) =>
    ({
      id,
      status: "active",
      customer,
      metadata: { organizationId },
    }) as unknown as Stripe.Subscription;

  const stubStripe = (opts: {
    byCustomer?: Record<string, Stripe.Subscription[]>;
    search?: Stripe.Subscription[];
    searchThrows?: boolean;
    onSearch?: (query: string) => void;
  }) => {
    let searchCalls = 0;
    return {
      searchCalls: () => searchCalls,
      stripe: {
        subscriptions: {
          list: async ({ customer }: { customer: string }) => ({
            data: opts.byCustomer?.[customer] ?? [],
          }),
          search: async ({ query }: { query: string }) => {
            searchCalls += 1;
            opts.onSearch?.(query);
            if (opts.searchThrows) throw new Error("search unavailable");
            return { data: opts.search ?? [] };
          },
        },
      } as unknown as Stripe,
    };
  };

  it("finds the subscription on a DIFFERENT customer than the one stored", async () => {
    const moved = live("sub_new", "cus_new", "org-1");
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [] },
      search: [moved],
    });

    const found = await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    // Both halves matter: the plan is recoverable AND the caller learns the
    // customer id to heal, so the drift is repaired instead of re-read.
    expect(found?.subscription.id).toBe("sub_new");
    expect(found?.customerId).toBe("cus_new");
  });

  it("uses the stored customer without searching when it still holds the sub", async () => {
    const { stripe, searchCalls } = stubStripe({
      byCustomer: { cus_old: [live("sub_1", "cus_old", "org-1")] },
    });

    const found = await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    expect(found?.subscription.id).toBe("sub_1");
    expect(searchCalls()).toBe(0); // fast path: no search index hit
  });

  it("never adopts another org's subscription from the search", async () => {
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [] },
      search: [live("sub_other", "cus_other", "org-2")],
    });

    // Stripe's search is a query string; a stray match must not become this
    // org's plan just because it came back.
    expect(
      await findOrgLiveSubscription(stripe, "org-1", "cus_old"),
    ).toBeUndefined();
  });

  it("scopes the search query to the org id", async () => {
    let seen = "";
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [] },
      onSearch: (q) => (seen = q),
    });

    await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    expect(seen).toBe("metadata['organizationId']:'org-1'");
  });

  it("ignores non-live subscriptions", async () => {
    const canceled = {
      id: "sub_dead",
      status: "canceled",
      customer: "cus_new",
      metadata: { organizationId: "org-1" },
    } as unknown as Stripe.Subscription;
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [] },
      search: [canceled],
    });

    expect(
      await findOrgLiveSubscription(stripe, "org-1", "cus_old"),
    ).toBeUndefined();
  });

  it("degrades to no-subscription when search is unavailable", async () => {
    // Search being down must not throw into the webhook/page path; the
    // stored-customer answer (nothing) is the pre-existing behavior.
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [] },
      searchThrows: true,
    });

    expect(
      await findOrgLiveSubscription(stripe, "org-1", "cus_old"),
    ).toBeUndefined();
  });

  it("searches even when the org has no stored customer at all", async () => {
    const { stripe } = stubStripe({
      search: [live("sub_x", "cus_x", "org-1")],
    });

    const found = await findOrgLiveSubscription(stripe, "org-1", null);

    expect(found?.customerId).toBe("cus_x");
  });

  it("never returns a sub belonging to another org on a SHARED customer", async () => {
    // The cross-tenant negative control. Stripe customers can be shared across
    // orgs, and /reactivate previously filtered on status alone — so org-1
    // could act on org-2's subscription. Every caller of this helper depends
    // on the org fence holding here.
    const { stripe } = stubStripe({
      byCustomer: { cus_shared: [live("sub_org2", "cus_shared", "org-2")] },
    });

    expect(
      await findOrgLiveSubscription(stripe, "org-1", "cus_shared"),
    ).toBeUndefined();
  });

  it("refuses to build a search query from an unsafe org id", async () => {
    // Negative control for the query-injection boundary: a crafted id must
    // never reach Stripe's search grammar, where a quote could break out of
    // the literal and return ANOTHER org's subscription (i.e. read a plan we
    // are not entitled to). It must fail closed, not fall through.
    const { stripe, searchCalls } = stubStripe({
      byCustomer: {},
      search: [live("sub_other", "cus_other", "org-2")],
    });

    const found = await findOrgLiveSubscription(
      stripe,
      "org-1' OR metadata['organizationId']:'org-2",
      null,
    );

    expect(found).toBeUndefined();
    expect(searchCalls()).toBe(0); // never even issued
  });

  it("keeps the stored customer id when the sub's customer is absent", async () => {
    const noCustomer = {
      id: "sub_1",
      status: "active",
      metadata: { organizationId: "org-1" },
    } as unknown as Stripe.Subscription;
    const { stripe } = stubStripe({ byCustomer: { cus_old: [noCustomer] } });

    const found = await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    expect(found?.customerId).toBe("cus_old");
  });

  it("returns a metadata-less live sub on the stored customer", async () => {
    // Dashboard/ops-created subscriptions carry no organizationId at all
    // (live prod example: the PO-billed enterprise sub). The org whose row
    // points at this customer is its one legitimate claimant — dropping it
    // would downgrade a paying dashboard-managed org to free, the exact bug
    // this helper exists to prevent.
    const unlabeled = {
      id: "sub_ent",
      status: "active",
      customer: "cus_old",
      metadata: {},
    } as unknown as Stripe.Subscription;
    const { stripe } = stubStripe({ byCustomer: { cus_old: [unlabeled] } });

    const found = await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    expect(found?.subscription.id).toBe("sub_ent");
    expect(found?.customerId).toBe("cus_old");
  });

  it("prefers a labeled sub found by search over an unlabeled stored one", async () => {
    // The unlabeled sub is the weakest claim: it belongs to the org only by
    // way of the customer pointer. A subscription explicitly carrying the
    // org's id — wherever it sits — is the org's real plan.
    const unlabeled = {
      id: "sub_unlabeled",
      status: "active",
      customer: "cus_old",
      metadata: {},
    } as unknown as Stripe.Subscription;
    const labeled = live("sub_labeled", "cus_new", "org-1");
    const { stripe } = stubStripe({
      byCustomer: { cus_old: [unlabeled] },
      search: [labeled],
    });

    const found = await findOrgLiveSubscription(stripe, "org-1", "cus_old");

    expect(found?.subscription.id).toBe("sub_labeled");
    expect(found?.customerId).toBe("cus_new");
  });

  it("ignores a non-live metadata-less sub on the stored customer", async () => {
    const dead = {
      id: "sub_dead",
      status: "canceled",
      customer: "cus_old",
      metadata: {},
    } as unknown as Stripe.Subscription;
    const { stripe } = stubStripe({ byCustomer: { cus_old: [dead] } });

    expect(
      await findOrgLiveSubscription(stripe, "org-1", "cus_old"),
    ).toBeUndefined();
  });
});

describe("findOrgLiveSubscriptions", () => {
  const live = (id: string, customer: string, organizationId: string) =>
    ({
      id,
      status: "active",
      customer,
      metadata: { organizationId },
    }) as unknown as Stripe.Subscription;

  const stubStripe = (opts: {
    byCustomer?: Record<string, Stripe.Subscription[]>;
    search?: Stripe.Subscription[];
  }) =>
    ({
      subscriptions: {
        list: async ({ customer }: { customer: string }) => ({
          data: opts.byCustomer?.[customer] ?? [],
        }),
        search: async () => ({ data: opts.search ?? [] }),
      },
    }) as unknown as Stripe;

  it("collects stored, searched, and unlabeled subs, deduped by id", async () => {
    // Org deletion cancels every one of these; missing any (the drifted one
    // on another customer, the unlabeled dashboard-created one) leaves a
    // subscription billing a deleted org forever.
    const storedLabeled = live("sub_a", "cus_old", "org-1");
    const unlabeled = {
      id: "sub_b",
      status: "active",
      customer: "cus_old",
      metadata: {},
    } as unknown as Stripe.Subscription;
    const drifted = live("sub_c", "cus_new", "org-1");
    const stripe = stubStripe({
      byCustomer: { cus_old: [storedLabeled, unlabeled] },
      // Search also re-returns sub_a: the dedup must not double-cancel it.
      search: [storedLabeled, drifted],
    });

    const found = await findOrgLiveSubscriptions(stripe, "org-1", "cus_old");

    expect(found.map((m) => m.subscription.id).sort()).toEqual([
      "sub_a",
      "sub_b",
      "sub_c",
    ]);
  });

  it("never includes another org's subscription", async () => {
    // The destructive caller (org deletion CANCELS what this returns): a
    // shared customer must not let org-1's deletion kill org-2's plan.
    const otherOrg = live("sub_other", "cus_shared", "org-2");
    const stripe = stubStripe({
      byCustomer: { cus_shared: [otherOrg] },
      search: [otherOrg],
    });

    expect(
      await findOrgLiveSubscriptions(stripe, "org-1", "cus_shared"),
    ).toEqual([]);
  });
});
