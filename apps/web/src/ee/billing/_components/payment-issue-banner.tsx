"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CreditCard } from "lucide-react";
import { queryKeys } from "@/lib/api/keys";
import { CAPS } from "@/lib/env";
import { generateOrgPrefix } from "@/lib/org-navigation";
import { getPaymentIssue } from "../payment-issue-actions";
import { formatDollars } from "../format";

/**
 * Tells admins why their paid plan disappeared. A failed renewal leaves the
 * org on Free (deliberately, only active/trialing counts as paid), and without
 * this the customer sees "Free" with no idea a card failed. Past due links to
 * Stripe's hosted invoice page, which takes a new card and pays in one step;
 * ended (retries exhausted) links to the billing page to resubscribe.
 *
 * Shows on every dashboard page, including billing, because billing is the
 * first place a confused customer looks.
 */
export const PaymentIssueBanner = () => {
  const { data: issue } = useQuery({
    queryKey: queryKeys.billing.paymentIssue(),
    queryFn: () => getPaymentIssue(),
    enabled: CAPS.billing,
    staleTime: 60_000,
    // Paying happens in another tab: re-check when the admin comes back.
    refetchOnWindowFocus: true,
  });

  if (!issue) return null;

  const orgPrefix = generateOrgPrefix(issue.organizationId);

  const isPastDue = issue.kind === "past_due";
  const title = isPastDue
    ? `Your ${issue.planName} payment of ${formatDollars(issue.amountDue)} failed`
    : `Your ${issue.planName} subscription ended because the payment failed`;
  const body = isPastDue
    ? `You're on the Free plan until it's paid. Update your card and pay to restore ${issue.planName} right away.`
    : `You're on the Free plan now. Resubscribe to get ${issue.planName} back.`;
  const cta = isPastDue ? "Update card & pay" : "Resubscribe";

  const className =
    "group mb-6 flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 transition-colors hover:bg-red-500/15 dark:border-red-500/40 dark:bg-red-500/15 dark:hover:bg-red-500/20";

  const content = (
    <>
      <CreditCard className="size-4 shrink-0 text-red-500" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{body}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-red-600 transition-colors group-hover:text-red-500 dark:text-red-400 dark:group-hover:text-red-300">
        {cta}
        <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
      </span>
    </>
  );

  // The status region announces the problem; the link keeps its link role
  // (role="alert" on the anchor itself would hide it from link navigation).
  return (
    <div role="status">
      {isPastDue ? (
        <a
          href={issue.invoiceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
        >
          {content}
        </a>
      ) : (
        <Link href={`${orgPrefix}/billing`} className={className}>
          {content}
        </Link>
      )}
    </div>
  );
};
