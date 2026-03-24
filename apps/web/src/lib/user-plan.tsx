"use server";

/** OSS default: no redirect needed. Cloud overrides via turbopack alias. */
export const checkDashboardRedirect = async (): Promise<string | null> => null;
