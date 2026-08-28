import { db } from "@onecli/db";

/**
 * Mark a user's onboarding complete. Idempotent: only writes when it hasn't been
 * completed yet, so it never clobbers an existing timestamp.
 */
export const markOnboardingCompleteForUser = async (
  userId: string,
): Promise<void> => {
  await db.user.updateMany({
    where: { id: userId, onboardingCompletedAt: null },
    data: { onboardingCompletedAt: new Date() },
  });
};

/**
 * Mark onboarding complete keyed by the API key embedded in a setup script — the
 * moment the user RUNS it. Used by the script-serving routes (`/v1/install/cli`,
 * `/v1/migrate/nanoclaw`) and `/v1/onboarding/install-complete` so that running
 * any flow — for any agent, even if the script later errors — takes the user out
 * of onboarding mode. No-op if the key is unknown.
 */
export const markOnboardingCompleteByApiKey = async (
  apiKey: string,
): Promise<void> => {
  const record = await db.apiKey.findUnique({
    where: { key: apiKey },
    select: { userId: true },
  });
  if (record) await markOnboardingCompleteForUser(record.userId);
};
