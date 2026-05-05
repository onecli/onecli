"use server";

/** OSS default: no redirect needed. Cloud overrides via turbopack alias. */
export const checkDashboardRedirect = async (): Promise<string | null> => null;

/** OSS default: no plan. Cloud overrides via turbopack alias. */
export const getCurrentPlan = async (): Promise<string | null> => null;
