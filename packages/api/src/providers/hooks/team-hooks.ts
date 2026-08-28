import { createEditionSlot } from "../edition-state";

/**
 * The two moments in the invitation flow an edition may want to intervene at.
 *
 * Inviting people is free — that is the licensing decision this seam exists to
 * honour. What is NOT free is a cloud plan's seat allowance, and what is not
 * universal is enterprise group→role mapping. Both used to live inside the
 * invitation code; the code moved out from under the licence and they stayed
 * behind this slot.
 *
 * Deliberately an edition SLOT rather than a `SessionHooks`-style parameter:
 * session hooks are handed to `createApiApp`, and the web's server actions
 * never call it (`apps/web/src/lib/init/server.ts` runs `ensureEditionDefaults()`
 * instead) — a host-passed hook would simply never be injected on the path
 * invitations actually run through.
 */
export interface TeamHooks {
  /**
   * Runs before an invitation is written. Throws to refuse — cloud raises
   * `QuotaExceededError` once the plan's seats are spoken for. A resend of a
   * still-pending invitation does not reach here: that seat is already
   * committed.
   */
  beforeInviteMember(organizationId: string): Promise<void>;
  /**
   * Runs after someone becomes a member. Enterprise reconciles the role
   * against directory group mappings here, so an IdP-governed user gets the
   * role their groups dictate rather than the one the invite offered.
   */
  afterMemberJoined(organizationId: string, userId: string): Promise<void>;
}

const noopTeamHooks: TeamHooks = {
  beforeInviteMember: async () => {},
  afterMemberJoined: async () => {},
};

// Edition default: cloud enforces the plan's seat cap and reconciles IdP roles
// — injected by `ensureEditionDefaults()`, which keeps the quota service (and
// its billing graph) out of client bundles. An unlicensed self-host has
// neither, and invites are unlimited there.
const slot = createEditionSlot<TeamHooks>("teamHooks", noopTeamHooks);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultTeamHooks = (h: TeamHooks) => slot.setCloudDefault(h);

/** Package-internal: the licensed-self-host path, and test overrides. */
export const initTeamHooks = (h: TeamHooks | null) => slot.init(h);

export const getTeamHooks = (): TeamHooks => slot.get();
