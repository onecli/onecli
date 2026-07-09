"use server";

/** OSS default: no redirect needed. The EE editions override this via turbopack alias. */
export const checkDashboardRedirect = async (): Promise<string | null> => null;

/** OSS default: no plan. The EE editions override this via turbopack alias. */
export const getCurrentPlan = async (): Promise<string | null> => null;
