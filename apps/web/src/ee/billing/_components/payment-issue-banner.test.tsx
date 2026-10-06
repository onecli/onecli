// @vitest-environment jsdom
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  issue: null as unknown,
  getPaymentIssue: vi.fn(async () => state.issue),
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  CAPS: { billing: true },
}));
vi.mock("../payment-issue-actions", () => ({
  getPaymentIssue: state.getPaymentIssue,
}));

import { PaymentIssueBanner } from "./payment-issue-banner";

const renderBanner = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentIssueBanner />
    </QueryClientProvider>,
  );
  return queryClient;
};

afterEach(() => {
  cleanup();
  state.issue = null;
  state.getPaymentIssue.mockClear();
});

describe("PaymentIssueBanner", () => {
  it("renders nothing when there is no payment issue", async () => {
    const queryClient = renderBanner();
    // Assert absence only once the query has actually settled, not before
    // it ran (which would pass vacuously).
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(state.getPaymentIssue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("past due: links to the hosted invoice page in a new tab", async () => {
    state.issue = {
      kind: "past_due",
      plan: "pro",
      planName: "Pro",
      amountDue: 1250,
      invoiceUrl: "https://invoice.stripe.com/i/test",
      organizationId: "org-1",
    };
    renderBanner();

    const region = await screen.findByRole("status");
    const alert = within(region).getByRole("link");
    expect(alert.textContent).toContain("Your Pro payment of $12.50 failed");
    expect(alert.textContent).toContain("Update card & pay");
    expect(alert.getAttribute("href")).toBe(
      "https://invoice.stripe.com/i/test",
    );
    expect(alert.getAttribute("target")).toBe("_blank");
    expect(alert.getAttribute("rel")).toContain("noopener");
  });

  it("ended: links to the org billing page to resubscribe", async () => {
    state.issue = {
      kind: "ended",
      plan: "pro",
      planName: "Pro",
      endedAt: "2026-09-20T00:00:00.000Z",
      organizationId: "org-1",
    };
    renderBanner();

    const region = await screen.findByRole("status");
    const alert = within(region).getByRole("link");
    expect(alert.textContent).toContain(
      "Your Pro subscription ended because the payment failed",
    );
    expect(alert.textContent).toContain("Resubscribe");
    expect(alert.getAttribute("href")).toBe("/org/org-1/billing");
  });
});
