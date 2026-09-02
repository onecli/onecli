import type { InstanceInfo } from "@/lib/api/types";
import { ApiError } from "@/lib/api/client";

/**
 * Whether the hosted surface exists at all, and what to say when it does but
 * isn't working (§3.13).
 *
 * Runners are INVISIBLE as an object: no page, no nav entry, no runner
 * vocabulary anywhere a user can read. What a user sees is their agent, and
 * whether it can run right now. This is the only place that translation
 * happens, so the words cannot drift between the agent list, the chat header
 * and the composer.
 */

export type HostedAvailability =
  /** Still asking. NEVER render this as unavailable — a flash of the wrong
   *  empty state reads as a broken product. */
  | "loading"
  /** No runner has ever registered: this deployment has no hosted agents and
   *  the whole surface stays hidden, exactly as it looks today. */
  | "absent"
  /** Registered but nothing is reporting — agents exist and cannot run. */
  | "offline"
  | "ready";

export const hostedAvailability = (
  instance: InstanceInfo | null,
): HostedAvailability => {
  if (!instance) return "loading";
  // An older API answers without the field. Absent means "no hosted agents
  // here", never a crash and never a false "offline".
  if (!instance.runners?.registered) return "absent";
  return instance.runners.online ? "ready" : "offline";
};

/** Is the hosted surface shown at all? Loading hides it — see "loading". */
export const showsHostedSurface = (a: HostedAvailability): boolean =>
  a === "ready" || a === "offline";

/**
 * Sending is deliberately NEVER gated on availability: the server accepts a
 * turn in every state and queues it (§3.18 rule 3 — configuration never
 * blocks conversation), which is the exact promise OFFLINE_MESSAGE makes.
 * Only agent CREATION needs a live agent host — hence the one create-side
 * gate below and no send-side one.
 */

/**
 * What to tell someone whose agents cannot run. Deliberately about the agents,
 * not the infrastructure: "the runner has not reported" is our problem
 * described in our words.
 */
export const OFFLINE_MESSAGE =
  "Your agents are offline and can't pick up new messages yet. Anything you send will run as soon as they're back.";

/** The same state at the create door — a new agent has nowhere to start. */
export const OFFLINE_CREATE_MESSAGE =
  "Your agents are offline. A new agent can't start until they're back.";

/** Hosted-create refusals in our vocabulary — never the API's (§3.13).
 * Shared by every hosted-create surface (the agents dialog, onboarding). */
export const hostedCreateRefusalCopy = (error: Error): string => {
  if (error instanceof ApiError) {
    // The collision is on the DERIVED identifier — two different names can
    // normalize to the same one, so don't claim the name itself is taken.
    if (error.status === 409)
      return "An agent with a matching identifier already exists. Pick a different name.";
    // Hosted-create's only 422 today is "no host available" (validation
    // failures are 400s, duplicates 409s) — revisit if that ever changes.
    if (error.status === 422) return OFFLINE_CREATE_MESSAGE;
  }
  return error.message;
};

/**
 * The one honest sentence about where agent files live (§3.9), keyed off the
 * platform's declared durability class — stated, never assumed. Agent
 * vocabulary only (files, sleeping), exactly like everything else here: what
 * implements the durability is never a word a user reads. Null (an older API,
 * nothing online) renders nothing rather than a guess.
 */
export const homeDurabilityMessage = (
  instance: InstanceInfo | null,
): string | null => {
  switch (instance?.runners?.homeDurability) {
    case "snapshot":
      return "Your agent's files are archived to durable storage whenever it sleeps.";
    case "resident":
      return "Your agent's files live on this deployment's own disk.";
    default:
      return null;
  }
};
