export type StepSlug = "welcome" | "create";

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

/** One flow now: mission → create (agent boots, then "meet your agent"). */
export const STEP_SLUGS: StepSlug[] = ["welcome", "create"];

/** Human-readable step names, used for progress-dot accessibility labels. */
export const STEP_LABELS: Record<StepSlug, string> = {
  welcome: "Welcome",
  create: "Create your agent",
};

const STEP_PATH_RE = /^\/onboarding\/([^/]+)\/?$/;

export const stepSlugFromPathname = (pathname: string): StepSlug | null => {
  const slug = STEP_PATH_RE.exec(pathname)?.[1];
  return STEP_SLUGS.find((s) => s === slug) ?? null;
};

/** The furthest step the user's saved progress supports — used by the index
 * resume redirect. A user with a created agent resumes on the create step,
 * which renders its finished boot screen with the "meet your agent" door. */
export const stepPathForProgress = (progress: OnboardingProgress): string => {
  if (progress.createdAgentId) return onboardingPath("create");
  return onboardingPath("welcome");
};
