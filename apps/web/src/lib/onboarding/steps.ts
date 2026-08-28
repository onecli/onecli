export type StepSlug = "welcome" | "create" | "team";

/** Saved answers persisted in `OnboardingSurvey`, used to seed the client
 * flow and to derive which step a user may visit. Only `discovery` survives
 * from the v1 survey; v2 records the hosted agent it created. */
export interface OnboardingProgress {
  discovery: string[];
  agentName: string | null;
  /** The hosted agent created during onboarding, once it exists. */
  createdAgentId?: string | null;
}

export const onboardingPath = (slug?: StepSlug): string =>
  slug ? `/onboarding/${slug}` : "/onboarding";

/** One flow now: mission → create (agent boots) → team. */
export const STEP_SLUGS: StepSlug[] = ["welcome", "create", "team"];

/** Human-readable step names, used for progress-dot accessibility labels. */
export const STEP_LABELS: Record<StepSlug, string> = {
  welcome: "Welcome",
  create: "Create your agent",
  team: "Invite your team",
};

const STEP_PATH_RE = /^\/onboarding\/([^/]+)\/?$/;

export const stepSlugFromPathname = (pathname: string): StepSlug | null => {
  const slug = STEP_PATH_RE.exec(pathname)?.[1];
  return STEP_SLUGS.find((s) => s === slug) ?? null;
};

/** The furthest step the user's saved progress supports — used by the index
 * resume redirect and as the fallback target when a step guard rejects. */
export const stepPathForProgress = (progress: OnboardingProgress): string => {
  if (progress.createdAgentId) return onboardingPath("team");
  return onboardingPath("welcome");
};

/** Whether a step's prerequisites are met. Earlier steps stay reachable after
 * later progress so back-navigation always works. `team` needs the agent the
 * step talks about ("while it boots") to exist. */
export const isStepAllowed = (
  slug: StepSlug,
  progress: OnboardingProgress,
): boolean => {
  switch (slug) {
    case "welcome":
    case "create":
      return true;
    case "team":
      return !!progress.createdAgentId;
  }
};
