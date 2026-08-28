/**
 * Starter briefs (§3.11).
 *
 * An empty textarea labelled "What should it do?" is the hardest question in
 * the create flow: people know what they want and not what a brief looks like.
 * Three concrete ones make the field feel like describing a colleague's job
 * rather than filling in a config field — which is the whole difference
 * between hiring and provisioning.
 *
 * Deliberately written as instructions to a person, in the second person, with
 * a standing job and a rule about how to do it. They are examples, not
 * templates: the user is expected to edit whichever they pick.
 *
 * One definition, used by the create dialog and by the Instructions editor
 * when the brief is empty, so the two can't drift.
 */
export interface BriefExample {
  /** Short enough to be a button label. */
  label: string;
  text: string;
}

export const BRIEF_EXAMPLES: readonly BriefExample[] = [
  {
    label: "Support triage",
    text: "Triage our support inbox. For each new message, work out what the customer is actually blocked on, check our docs and recent issues before answering, and draft a reply in my voice: warm, direct, no filler. Flag anything involving billing or a security report instead of answering it yourself.",
  },
  {
    label: "Release notes",
    text: "Watch our merged pull requests and keep a running draft of the next release's notes. Group changes by what they mean for a user rather than by which service changed, and skip anything purely internal. When you are unsure whether a change is user-visible, say so instead of guessing.",
  },
  {
    label: "On-call helper",
    text: "Help whoever is on call. When asked about an alert, pull the relevant logs and recent deploys first, then say what you think is happening and how confident you are. Never restart or scale anything yourself. Propose the command and let a human run it.",
  },
] as const;
