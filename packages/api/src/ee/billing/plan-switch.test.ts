import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  buildPlanSwitchItems,
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
