/**
 * What a person can do to one of their waiting messages (a message sent
 * while the agent works, not yet read) from a channel surface, provider-
 * neutral: each provider maps its own control (Slack: a button on that
 * message's row of the agent's card) to one of these, the adapter relays it
 * on the wire, and the control plane acts on it. One list, so the three can
 * never disagree on the vocabulary.
 */
export const FOLLOW_UP_ACTIONS = ["send_now"] as const;
export type FollowUpAction = (typeof FOLLOW_UP_ACTIONS)[number];
