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

/**
 * Was THIS agent created by THIS user during onboarding?
 *
 * The onboarding flow records the agent it created — `responses.createdAgentId`
 * on the workspace's `OnboardingSurvey` — and the web awaits that write before
 * it navigates into the chat, so the row is already there when the thread-open
 * door asks.
 *
 * It exists for the greeting (`greeting-service`), which is a FIRST-RUN
 * moment and nothing else: every agent a person creates later, from the
 * dashboard, opens a thread the same way, and greeting those was the bug this
 * predicate closes.
 *
 * BOTH halves are load-bearing:
 *
 *   - `createdAgentId` is what separates the onboarding agent from the fifth
 *     agent someone makes on a Tuesday.
 *   - `userId` is what keeps a COLLEAGUE out of it. Direct threads are
 *     per-user (each workspace member has their own private thread with an
 *     agent), so without this a second member opening the onboarding agent
 *     would be greeted as if they had just signed up.
 *
 * The survey is keyed by `workspaceId`, so the workspace fence is the lookup
 * itself. Reads defensively: `responses` is a `Json` column — anything that
 * isn't the expected shape simply means "not the onboarding agent".
 */
export const isOnboardingCreatedAgent = async (
  workspaceId: string,
  agentId: string,
  userId: string,
): Promise<boolean> => {
  const survey = await db.onboardingSurvey.findUnique({
    where: { workspaceId },
    select: { userId: true, responses: true },
  });
  // No survey at all: a workspace that predates onboarding, or one nobody
  // onboarded into. Nothing here was created by the flow.
  if (!survey) return false;
  if (survey.userId !== userId) return false;

  const responses =
    survey.responses &&
    typeof survey.responses === "object" &&
    !Array.isArray(survey.responses)
      ? (survey.responses as Record<string, unknown>)
      : {};

  return responses.createdAgentId === agentId;
};
