"use server";

import { db } from "@onecli/db";
import { getStripe } from "@onecli/api/ee/billing/stripe";
import { getRedis } from "@onecli/api/ee/clients/redis-client";
import { redisKeys } from "@onecli/api/ee/clients/redis-keys";
import {
  resolveOrgContext,
  requireOrgAdminContext,
} from "@/lib/actions/resolve-user";
import { PRICE_TO_PLAN } from "@onecli/api/ee/billing/price-map";
import { normalizePlan } from "@onecli/api/ee/billing/plans";
import {
  getUsageOverview,
  type UsageOverview,
} from "@onecli/api/ee/services/quota-service";

const MGET_BATCH_SIZE = 500;

export interface AgentUsage {
  agentId: string;
  agentName: string;
  requests: number;
  injections: number;
}

export interface ApiRequestsData {
  totalUsed: number;
  totalInjections: number;
  plan: string;
  periodStart: string;
  periodEnd: string;
  perAgent: AgentUsage[];
}

// Admin/owner-only: returns org-wide, per-agent request and injection detail for
// the (admin) Usage page. As a server action it compiles to a POST endpoint any
// authenticated user could invoke, so it gates on role here (Layer 3) rather than
// relying on the page guard alone. getPlanUsage below stays member-readable — it
// feeds the sidebar quota shown to every member.
export async function getApiRequests(): Promise<ApiRequestsData> {
  const { organizationId } = await requireOrgAdminContext();

  const organization = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { stripeCustomerId: true, subscriptionStatus: true },
  });

  let plan: string = normalizePlan(organization.subscriptionStatus ?? "free");
  let periodStart: Date;
  let periodEnd: Date;

  if (organization.stripeCustomerId) {
    try {
      const stripe = getStripe();
      const subs = await stripe.subscriptions.list({
        customer: organization.stripeCustomerId,
        limit: 1,
      });

      const activeSub = subs.data.find(
        (s) => s.status === "active" || s.status === "trialing",
      );

      if (activeSub) {
        ({ periodStart, periodEnd } = billingPeriod(
          activeSub.billing_cycle_anchor,
        ));
        const priceId = activeSub.items.data[0]?.price.id;
        plan = (priceId && PRICE_TO_PLAN[priceId]) || plan;
      } else {
        ({ periodStart, periodEnd } = calendarMonth());
        plan = "free";
      }
    } catch {
      ({ periodStart, periodEnd } = calendarMonth());
    }
  } else {
    ({ periodStart, periodEnd } = calendarMonth());
  }

  // Get all agents across all workspaces in the org
  const agents = await db.agent.findMany({
    where: { workspace: { organizationId } },
    select: { id: true, name: true, workspaceId: true },
  });

  // Generate date strings for the billing period (up to today)
  const dates = dateRangeStrings(periodStart, periodEnd);

  const perAgent: AgentUsage[] = [];
  let totalUsed = 0;
  let totalInjections = 0;

  try {
    const redis = getRedis();

    const requestKeys: string[] = [];
    const injectionKeys: string[] = [];
    const keysPerAgent: number[] = [];
    for (const agent of agents) {
      const agentRequestKeys = dates.map((d) =>
        redisKeys.requests(organizationId, agent.workspaceId, agent.id, d),
      );
      const agentInjectionKeys = dates.map((d) =>
        redisKeys.injections(organizationId, agent.workspaceId, agent.id, d),
      );
      requestKeys.push(...agentRequestKeys);
      injectionKeys.push(...agentInjectionKeys);
      keysPerAgent.push(agentRequestKeys.length);
    }

    const fetchValues = async (keys: string[]) => {
      const values: (string | null)[] = [];
      for (let i = 0; i < keys.length; i += MGET_BATCH_SIZE) {
        const chunk = keys.slice(i, i + MGET_BATCH_SIZE);
        const result = await redis.mget(...chunk);
        values.push(...result);
      }
      return values;
    };

    const [requestValues, injectionValues] = await Promise.all([
      fetchValues(requestKeys),
      fetchValues(injectionKeys),
    ]);

    const sumSlice = (
      values: (string | null)[],
      start: number,
      count: number,
    ) =>
      values
        .slice(start, start + count)
        .reduce(
          (sum: number, v: string | null) =>
            sum + (v ? parseInt(v, 10) || 0 : 0),
          0,
        );

    let offset = 0;
    for (let i = 0; i < agents.length; i++) {
      const count = keysPerAgent[i]!;
      const requests = sumSlice(requestValues, offset, count);
      const injections = sumSlice(injectionValues, offset, count);
      offset += count;

      totalUsed += requests;
      totalInjections += injections;
      perAgent.push({
        agentId: agents[i]!.id,
        agentName: agents[i]!.name,
        requests,
        injections,
      });
    }
  } catch {
    for (const agent of agents) {
      perAgent.push({
        agentId: agent.id,
        agentName: agent.name,
        requests: 0,
        injections: 0,
      });
    }
  }

  perAgent.sort((a, b) => b.requests - a.requests);

  return {
    totalUsed,
    totalInjections,
    plan,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    perAgent,
  };
}

/**
 * Compute the current billing period from a Stripe billing_cycle_anchor.
 * The anchor is the day-of-month the subscription renews. We find the most
 * recent occurrence of that day and the next one.
 */
function billingPeriod(anchorTimestamp: number): {
  periodStart: Date;
  periodEnd: Date;
} {
  const anchor = new Date(anchorTimestamp * 1000);
  const anchorDay = anchor.getUTCDate();
  const now = new Date();

  // Start from the anchor day in the current month, clamped to the last day
  // of the month (e.g. anchor day 31 in February → Feb 28/29).
  let periodStart = clampedUTCDate(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    anchorDay,
  );

  // If we haven't reached the anchor day yet this month, go back one month
  if (periodStart > now) {
    periodStart = clampedUTCDate(
      now.getUTCFullYear(),
      now.getUTCMonth() - 1,
      anchorDay,
    );
  }

  const periodEnd = clampedUTCDate(
    periodStart.getUTCFullYear(),
    periodStart.getUTCMonth() + 1,
    anchorDay,
  );

  return { periodStart, periodEnd };
}

/** Create a UTC date, clamping `day` to the last day of the target month. */
function clampedUTCDate(year: number, month: number, day: number): Date {
  // Day 0 of the next month = last day of the target month
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

function calendarMonth(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  };
}

/** Day strings (YYYY-MM-DD, UTC) covering [start, min(end, today)]. */
function dateRangeStrings(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const cap = new Date(Math.min(end.getTime(), Date.now()));
  while (current <= cap) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export { type UsageOverview };

export type PlanUsage = UsageOverview & {
  organizationId: string;
  organizationName: string;
};

export async function getPlanUsage(): Promise<PlanUsage> {
  const { organizationId } = await resolveOrgContext();
  const [overview, org] = await Promise.all([
    getUsageOverview(organizationId),
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true },
    }),
  ]);
  return { ...overview, organizationId, organizationName: org.name };
}
