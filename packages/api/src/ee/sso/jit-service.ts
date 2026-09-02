import { memberProvisionOps } from "../../services/organization-service";
import { db, Prisma } from "@onecli/db";
import type { SessionUser } from "../../providers/types";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  withAudit,
} from "../../services/audit-service";
import { logger } from "../../lib/logger";
import { reconcileMemberRoles } from "../services/team-service";
import { markConnectionActive } from "./sso-connection-service";
import { findSsoOrgForIdentity } from "./sso-trust";

const log = logger.child({ component: "sso-jit" });

/**
 * SSO JIT membership — the EE implementation of the session route's
 * `ensureSessionMembership` hook. On every session whose identity belongs
 * to an org's live SSO connection (verified-domain trust, sso-trust.ts):
 * promote the connection pending → active (first successful login completes
 * step 6's lifecycle), and when the org has JIT enabled and the user isn't
 * a member yet, join them as `member` with their own default workspace.
 *
 * NEVER throws: membership is best-effort and session resolution must
 * survive it (the route contract). Idempotent under concurrent sessions —
 * the member create races resolve via the composite-PK unique violation,
 * which is treated as the no-op it is.
 */
export const ensureSsoJitMembership = async (
  session: SessionUser,
  user: { id: string; email: string; name: string | null },
): Promise<void> => {
  try {
    const ssoOrg = await findSsoOrgForIdentity(
      session.identityProviders ?? [],
      user.email,
    );
    if (!ssoOrg) return;

    await markConnectionActive(ssoOrg.connectionId, ssoOrg.organizationId, {
      id: user.id,
      email: user.email,
    });

    // Deliberately status-blind: a SUSPENDED membership must also short-
    // circuit here — filtering it out would re-mint a fresh active row on
    // the suspended user's next SSO login.
    const membership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: ssoOrg.organizationId,
          userId: user.id,
        },
      },
      select: { userId: true },
    });
    if (membership) {
      // Existing member: re-resolve their org role from group→role mappings
      // (step 15). Best-effort — reconcile never throws.
      await reconcileMemberRoles(
        ssoOrg.organizationId,
        [user.id],
        AUDIT_SOURCE.SSO_LOGIN,
      );
      return;
    }

    const org = await db.organization.findUnique({
      where: { id: ssoOrg.organizationId },
      select: { jitEnabled: true },
    });
    if (!org?.jitEnabled) return;

    await withAudit(
      () =>
        db.$transaction([
          ...memberProvisionOps(
            ssoOrg.organizationId,
            user.id,
            user.email,
            "member",
            user.name,
          ),
        ]),
      () => ({
        organizationId: ssoOrg.organizationId,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.MEMBER,
        source: AUDIT_SOURCE.SSO_JIT,
        metadata: {
          organizationId: ssoOrg.organizationId,
          role: "member",
          connectionId: ssoOrg.connectionId,
        },
      }),
    );

    // A user SCIM-added to mapped groups before their first login lands here as
    // a brand-new JIT member — re-resolve now so the mapping applies immediately.
    await reconcileMemberRoles(
      ssoOrg.organizationId,
      [user.id],
      AUDIT_SOURCE.SSO_LOGIN,
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Concurrent session already created the membership — the outcome we
      // wanted exists.
      return;
    }
    log.error(
      { err, userId: user.id },
      "SSO JIT membership failed — session continues without it",
    );
  }
};
