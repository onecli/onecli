import type { TeamHooks } from "../../providers/hooks/team-hooks";
import { assertCanInviteMember } from "../services/quota-service";
import { cleanupExpiredProvisions } from "../services/user-provision-service";
import { reconcileMemberRoles } from "../services/team-service";
import { AUDIT_SOURCE } from "../../services/audit-service";
import { logger } from "../../lib/logger";

/**
 * The licensed half of the invitation flow: the plan's seat cap, and the
 * directory group→role mapping that overrides an invited role.
 *
 * Both are deliberately wrappers rather than bare references — this module
 * loads with the providers barrel in every process, so dereferencing the
 * imports at module scope would break partial `vi.mock()`s and import cycles
 * (the same reasoning as `ee/hooks/resource-hooks.ts`).
 */
export const eeTeamHooks: TeamHooks = {
  beforeInviteMember: async (organizationId) => {
    // Placeholders occupy real seats until their expiry sweep runs — clean
    // the dead ones first so an expired provision never blocks a live invite
    // (non-fatal, matching the provision flow's own posture).
    await cleanupExpiredProvisions(organizationId).catch((err) =>
      logger.warn({ err }, "expired-provision sweep failed"),
    );
    await assertCanInviteMember(organizationId);
  },
  afterMemberJoined: async (organizationId, userId) => {
    // If a group→role mapping already governs this user, it overrides the
    // invited role (IdP wins); a no-op when nothing maps them.
    await reconcileMemberRoles(organizationId, [userId], AUDIT_SOURCE.API);
  },
};
