import { beforeEach, describe, expect, it, vi } from "vitest";

// The action hands out the open invoice's pay link, so the admin gate is the
// security boundary: a plain member (or a caller the role check rejects) must
// get nothing, and Stripe must not even be asked.

const state = vi.hoisted(() => ({
  roleThrows: false,
  stripeCustomerId: "cus_1" as string | null,
  findCalls: 0,
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  CAPS: { billing: true },
}));
vi.mock("@/lib/actions/resolve-user", () => ({
  requireOrgAdminContext: async () => {
    if (state.roleThrows) throw new Error("FORBIDDEN");
    return {
      userId: "u-1",
      userEmail: "u@example.com",
      organizationId: "org-1",
    };
  },
}));
vi.mock("@onecli/db", () => ({
  db: {
    organization: {
      findUniqueOrThrow: async () => ({
        stripeCustomerId: state.stripeCustomerId,
      }),
    },
  },
}));
vi.mock("@onecli/api/ee/billing/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@onecli/api/ee/billing/payment-issue", () => ({
  findOrgPaymentIssue: async () => {
    state.findCalls += 1;
    return {
      kind: "past_due",
      plan: "pro",
      planName: "Pro",
      amountDue: 1250,
      invoiceUrl: "https://invoice.stripe.com/i/test",
    };
  },
}));

import { getPaymentIssue } from "./payment-issue-actions";

beforeEach(() => {
  state.roleThrows = false;
  state.stripeCustomerId = "cus_1";
  state.findCalls = 0;
});

describe("getPaymentIssue", () => {
  it("returns the issue with the org id for an admin", async () => {
    expect(await getPaymentIssue()).toMatchObject({
      kind: "past_due",
      organizationId: "org-1",
    });
  });

  it("returns null for a non-admin without touching Stripe", async () => {
    state.roleThrows = true;
    expect(await getPaymentIssue()).toBeNull();
    expect(state.findCalls).toBe(0);
  });

  it("returns null for an org with no Stripe customer", async () => {
    state.stripeCustomerId = null;
    expect(await getPaymentIssue()).toBeNull();
    expect(state.findCalls).toBe(0);
  });
});
