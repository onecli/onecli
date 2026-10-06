/**
 * The grouped-approval decide contract, provider-neutral: one click on a
 * grouped card decides at most `APPROVAL_GROUP_MAX_IDS` approvals, each id in
 * the opaque shape a card can carry without escaping (the gateway mints
 * UUIDs). Each provider's card fits its own wire limits inside this cap; the
 * control plane's decide and the adapter wire schema enforce it.
 */

/** The most approval ids one grouped click may carry. */
export const APPROVAL_GROUP_MAX_IDS = 50;

/** An approval id as a grouped card carries it: `[A-Za-z0-9_-]`, no
 *  separators, so it joins into a list or a `decision|id` pair as-is. */
export const APPROVAL_GROUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
