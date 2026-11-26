export type StepSlug = "welcome" | "create";

/** Saved answers persisted in `OnboardingSurvey`, used to seed the client
 * flow and to derive which step a user may visit. Only `discovery` survives
 * from the v1 survey; v2 records the hosted agent it created. */
export interface OnboardingProgress {
  discovery: string[];
  /** Step 1: the team's messaging tool ("slack" | "teams" | "other"). */
  messagingTool?: string | null;
  /** Free text when `messagingTool` is "other". */
  messagingToolOther?: string | null;
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
 * resume redirect. The agent is created at the WELCOME step (as the default
 * name), so an agent's mere existence proves nothing about where the person
 * was; a name OTHER than the default is what the name step wrote, and a
 * resume past it lands on the create step's boot screen with the "meet your
 * agent" door. */
export const stepPathForProgress = (progress: OnboardingProgress): string => {
  if (nameStepPassed(progress)) return onboardingPath("create");
  return onboardingPath("welcome");
};

/** The agent's name until the person picks one. */
export const DEFAULT_AGENT_NAME = "Donna";

/** Whether the name step was completed: the flow's agent exists AND carries
 * a name the person gave it (the welcome-step create uses the default). */
export const nameStepPassed = (progress: OnboardingProgress): boolean =>
  Boolean(progress.createdAgentId) &&
  progress.agentName !== null &&
  progress.agentName !== DEFAULT_AGENT_NAME;
