import crypto from "crypto";
import { db } from "@onecli/db";
import { generateApiKey } from "../../services/api-key-service";
import { workspaceNameForOwner } from "../../services/organization-service";
import { generateWorkspaceId } from "../../lib/ids";
import { ServiceError } from "../../services/errors";
import { assertEntitled } from "../../lib/entitlements-guard";
import { isEntitled } from "../../lib/entitlements";
import { assertCanInviteMember } from "./quota-service";
import { deleteWorkspaceContent } from "./workspace-service";
import { deletePlaceholderUser } from "./user-service";
import { invalidateGatewayCacheForKeys } from "../../lib/gateway-invalidate";
import { logger } from "../../lib/logger";

const PROVISION_EXPIRY_DAYS = 7;
const PLACEHOLDER_EMAIL_DOMAIN = "onecli.internal";

const generateProvisionToken = (): string =>
  crypto.randomBytes(32).toString("hex");

const generatePlaceholderEmail = (id: string): string =>
  `provision-${id}@${PLACEHOLDER_EMAIL_DOMAIN}`;

const generatePlaceholderAuthId = (id: string): string => `provision-${id}`;

export const isPlaceholderEmail = (email: string): boolean =>
  email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);

export interface ProvisionResult {
  id: string;
  userId: string;
  workspaceId: string;
  apiKey: string;
  claimUrl: string;
  expiresAt: Date;
}

export interface PendingProvision {
  id: string;
  role: string;
  provisionedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
}

const ALLOWED_PROVISION_ROLES = new Set(["admin", "member"]);

export const provisionUser = async (params: {
  organizationId: string;
  role: string;
  skipOnboarding?: boolean;
  provisionedById: string;
  provisionedByEmail: string;
  appUrl: string;
}): Promise<ProvisionResult> => {
  if (!ALLOWED_PROVISION_ROLES.has(params.role)) {
    throw new ServiceError("BAD_REQUEST", "Invalid role");
  }

  // License first (cheap, no DB), then the seat cap: a provisioned
  // placeholder occupies a real seat the moment it's created. Clean expired
  // provisions before the cap check so a dead placeholder never blocks a
  // live one (cleanup failure is non-fatal, matching listProvisions).
  assertEntitled("provisioning");
  await cleanupExpiredProvisions(params.organizationId).catch((err) =>
    logger.warn({ err }, "expired-provision sweep failed"),
  );
  await assertCanInviteMember(params.organizationId);

  const placeholderId = crypto.randomUUID();
  const placeholderEmail = generatePlaceholderEmail(placeholderId);
  const placeholderAuthId = generatePlaceholderAuthId(placeholderId);
  const token = generateProvisionToken();
  const apiKey = generateApiKey();
  const workspaceId = generateWorkspaceId();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + PROVISION_EXPIRY_DAYS);

  const result = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: placeholderEmail,
        externalAuthId: placeholderAuthId,
        onboardingCompletedAt: params.skipOnboarding ? new Date() : null,
      },
    });

    await tx.organizationMember.create({
      data: {
        organizationId: params.organizationId,
        userId: user.id,
        userEmail: placeholderEmail,
        role: params.role,
      },
    });

    // The pre-provisioned workspace, seeded like every other workspace on
    // this codebase (API key + creator's owner binding — no agent; the
    // claimer creates the agents they want). The API key is pre-generated
    // above because the raw value must be returned to the provisioning
    // admin; the owner binding cascade-deletes with the placeholder when
    // the claim transfers to an existing account.
    //
    // The one exception to the workspaceNameForOwner law: the real owner is
    // unknown at mint (the placeholder's email is machine noise), so the
    // workspace is born "Default" and the claim renames it to its owner.
    const workspace = await tx.workspace.create({
      data: {
        id: workspaceId,
        name: "Default",
        slug: `default-${user.id.slice(0, 8)}`,
        organizationId: params.organizationId,
        createdByUserId: user.id,
        createdByUserEmail: placeholderEmail,
        apiKeys: {
          create: {
            key: apiKey,
            userId: user.id,
            userEmail: placeholderEmail,
          },
        },
        accessBindings: { create: { userId: user.id, role: "owner" } },
      },
    });

    const provision = await tx.userProvision.create({
      data: {
        organizationId: params.organizationId,
        userId: user.id,
        workspaceId: workspace.id,
        role: params.role,
        token,
        skipOnboarding: params.skipOnboarding ?? true,
        provisionedById: params.provisionedById,
        provisionedByEmail: params.provisionedByEmail,
        expiresAt,
      },
    });

    return {
      provisionId: provision.id,
      userId: user.id,
      workspaceId: workspace.id,
    };
  });

  return {
    id: result.provisionId,
    userId: result.userId,
    workspaceId: result.workspaceId,
    apiKey,
    claimUrl: `${params.appUrl}/claim?token=${token}`,
    expiresAt,
  };
};

/**
 * Resolve a claim link's token to what the claimer may be shown.
 *
 * The organization's name comes from here rather than from the URL (the
 * `findPendingInvitationByToken` posture), so a crafted `/claim?name=…`
 * cannot dress up a foreign link. Deliberately status-only — a time-expired
 * pending link still renders the form, and the claim attempt itself marks it
 * expired with a readable error, exactly as the flow always behaved.
 */
export const findPendingProvisionByToken = async (token: string) => {
  // Dark reads: unlicensed deployments resolve no token — not even the org
  // name behind it. Soft null (the caller's invalid-token arm), mirroring
  // claimProvision's freeze posture one call later.
  if (!isEntitled()) return null;
  const provision = await db.userProvision.findUnique({
    where: { token },
    select: { status: true, organization: { select: { name: true } } },
  });
  if (!provision || provision.status !== "pending") return null;
  return { organizationName: provision.organization.name };
};

export const claimProvision = async (
  token: string,
  realUserId: string,
  realUserEmail: string,
  realExternalAuthId: string,
): Promise<{
  organizationId: string;
  organizationName: string;
}> => {
  // Freeze posture: claiming a pre-minted placeholder is the provisioning
  // flow's second half — without the license the whole flow is inert, even
  // for links minted while it was licensed.
  assertEntitled("provisioning");
  const provision = await db.userProvision.findUnique({
    where: { token },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      workspaceId: true,
      status: true,
      skipOnboarding: true,
      expiresAt: true,
      organization: { select: { name: true } },
    },
  });

  if (!provision) {
    throw new ServiceError("NOT_FOUND", "Invalid claim link");
  }

  if (provision.status !== "pending") {
    throw new ServiceError(
      "CONFLICT",
      "This provision has already been claimed or expired",
    );
  }

  if (provision.expiresAt < new Date()) {
    // The flip keeps the refusal readable on retry; the row (and its seat,
    // workspace and key) is reaped by the next expiry sweep, which handles
    // "expired" as well as overdue-pending rows.
    await db.userProvision.update({
      where: { id: provision.id },
      data: { status: "expired" },
    });
    throw new ServiceError("BAD_REQUEST", "This provision link has expired");
  }

  // The pre-minted workspace can be deleted out from under a pending
  // provision through the normal workspace-delete route (workspaceId
  // deliberately has no FK). Refuse readably instead of exploding mid-
  // transfer; the expiry sweep reaps the leftovers.
  const workspaceExists = await db.workspace.findUnique({
    where: { id: provision.workspaceId },
    select: { id: true },
  });
  if (!workspaceExists) {
    throw new ServiceError("CONFLICT", "This provision is no longer available");
  }

  const existingUser = await db.user.findUnique({
    where: { id: realUserId },
    select: { id: true, name: true },
  });

  if (existingUser) {
    // Deliberately status-blind: a SUSPENDED membership counts as existing —
    // treating it as absent would re-provision the suspended user a fresh
    // active membership.
    const existingMembership = await db.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: provision.organizationId,
          userId: realUserId,
        },
      },
    });

    await db.$transaction(async (tx) => {
      // Atomic claim-of-the-claim (compare-and-set): only one transaction can
      // move the row out of "pending" — a concurrent duplicate blocks on the
      // row lock here and then matches nothing. A plain re-read would let two
      // simultaneous claims both pass and the loser silently overwrite the
      // winner's identity. "claiming" never persists: the branch ends by
      // deleting the row or setting "claimed", and a failure rolls it back.
      const won = await tx.userProvision.updateMany({
        where: { id: provision.id, status: "pending" },
        data: { status: "claiming" },
      });
      if (won.count === 0) {
        throw new ServiceError(
          "CONFLICT",
          "This provision has already been claimed",
        );
      }

      if (existingMembership) {
        await tx.organizationMember.delete({
          where: {
            organizationId_userId: {
              organizationId: provision.organizationId,
              userId: provision.userId,
            },
          },
        });
      } else {
        await tx.organizationMember.update({
          where: {
            organizationId_userId: {
              organizationId: provision.organizationId,
              userId: provision.userId,
            },
          },
          data: { userId: realUserId, userEmail: realUserEmail },
        });
      }

      await tx.workspace.update({
        where: { id: provision.workspaceId },
        data: {
          createdByUserId: realUserId,
          createdByUserEmail: realUserEmail,
          // The owner is finally known — apply the workspaceNameForOwner law
          // the mint had to defer (display-only; the slug is never resolved).
          name: workspaceNameForOwner(existingUser.name, realUserEmail),
        },
      });

      // Bind the real owner (step 13). The placeholder's seeded binding
      // cascade-deletes with the placeholder below — this is the durable row.
      await tx.workspaceAccess.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: provision.workspaceId,
            userId: realUserId,
          },
        },
        create: {
          workspaceId: provision.workspaceId,
          userId: realUserId,
          role: "owner",
        },
        update: { role: "owner" },
      });

      await tx.apiKey.updateMany({
        where: {
          workspaceId: provision.workspaceId,
          userId: provision.userId,
        },
        data: { userId: realUserId, userEmail: realUserEmail },
      });

      if (provision.skipOnboarding) {
        await tx.user.update({
          where: { id: realUserId },
          data: { onboardingCompletedAt: new Date() },
        });
      }

      await tx.userProvision.delete({ where: { id: provision.id } });
      await deletePlaceholderUser(provision.userId, tx);
    });
  } else {
    const authIdConflict = await db.user.findFirst({
      where: { externalAuthId: realExternalAuthId },
      select: { id: true },
    });
    if (authIdConflict) {
      throw new ServiceError(
        "CONFLICT",
        "This account is already registered with another user",
      );
    }

    await db.$transaction(async (tx) => {
      // Atomic claim-of-the-claim (compare-and-set): only one transaction can
      // move the row out of "pending" — a concurrent duplicate blocks on the
      // row lock here and then matches nothing. A plain re-read would let two
      // simultaneous claims both pass and the loser silently overwrite the
      // winner's identity. "claiming" never persists: the branch ends by
      // deleting the row or setting "claimed", and a failure rolls it back.
      const won = await tx.userProvision.updateMany({
        where: { id: provision.id, status: "pending" },
        data: { status: "claiming" },
      });
      if (won.count === 0) {
        throw new ServiceError(
          "CONFLICT",
          "This provision has already been claimed",
        );
      }

      await tx.user.update({
        where: { id: provision.userId },
        data: {
          email: realUserEmail,
          externalAuthId: realExternalAuthId,
        },
      });

      await tx.organizationMember.update({
        where: {
          organizationId_userId: {
            organizationId: provision.organizationId,
            userId: provision.userId,
          },
        },
        data: { userEmail: realUserEmail },
      });

      await tx.workspace.update({
        where: { id: provision.workspaceId },
        data: {
          createdByUserEmail: realUserEmail,
          // Same law as the existing-user branch; a fresh signup has no
          // display name yet, so this resolves to their email (clamped).
          name: workspaceNameForOwner(null, realUserEmail),
        },
      });

      // The placeholder is rebound to the real user in place (not deleted), so
      // its id now belongs to the claimer — bind it (idempotent; step 13).
      await tx.workspaceAccess.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: provision.workspaceId,
            userId: provision.userId,
          },
        },
        create: {
          workspaceId: provision.workspaceId,
          userId: provision.userId,
          role: "owner",
        },
        update: { role: "owner" },
      });

      await tx.apiKey.updateMany({
        where: {
          workspaceId: provision.workspaceId,
          userId: provision.userId,
        },
        data: { userEmail: realUserEmail },
      });

      await tx.userProvision.update({
        where: { id: provision.id },
        data: { status: "claimed", claimedAt: new Date() },
      });
    });
  }

  return {
    organizationId: provision.organizationId,
    organizationName: provision.organization.name,
  };
};

export const listProvisions = async (
  organizationId: string,
): Promise<PendingProvision[]> => {
  await cleanupExpiredProvisions(organizationId).catch((err) =>
    logger.warn({ err }, "expired-provision sweep failed"),
  );

  const provisions = await db.userProvision.findMany({
    where: { organizationId, status: "pending" },
    select: {
      id: true,
      role: true,
      provisionedByEmail: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return provisions;
};

export const cancelProvision = async (
  organizationId: string,
  provisionId: string,
): Promise<void> => {
  const provision = await db.userProvision.findUnique({
    where: { id: provisionId, organizationId, status: "pending" },
    select: { userId: true, workspaceId: true },
  });

  if (!provision) {
    throw new ServiceError("NOT_FOUND", "Provision not found");
  }

  await deleteProvisionResources(
    provisionId,
    provision.userId,
    provision.workspaceId,
  );
};

const deleteProvisionResources = async (
  provisionId: string,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  const keys = await db.$transaction(async (tx) => {
    // Capture the workspace's API keys before deleting them so they can be
    // flushed from the gateway cache after the transaction commits — otherwise
    // a deleted key keeps being served from the cache until its TTL.
    //
    // The workspace may already be gone (deleted through the normal
    // workspace-delete route — workspaceId has no FK on purpose); its content
    // died with it, so tear down only what remains or the whole reap wedges.
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    let apiKeys: { key: string }[] = [];
    if (workspace) {
      apiKeys = await tx.apiKey.findMany({
        where: { workspaceId },
        select: { key: true },
      });
      await deleteWorkspaceContent(workspaceId, tx);
    }
    await tx.organizationMember.deleteMany({ where: { userId } });
    await tx.userProvision.delete({ where: { id: provisionId } });
    await deletePlaceholderUser(userId, tx);
    return apiKeys;
  });
  invalidateGatewayCacheForKeys(keys.map((k) => k.key));
};

export const cleanupExpiredProvisions = async (
  organizationId: string,
): Promise<void> => {
  // "expired" rows are claim attempts on an overdue link (claimProvision
  // flips them for the readable error) — they hold a seat, a workspace and a
  // live API key exactly like an overdue pending row, so the sweep reaps both.
  const expired = await db.userProvision.findMany({
    where: {
      organizationId,
      status: { in: ["pending", "expired"] },
      expiresAt: { lt: new Date() },
    },
    select: { id: true, userId: true, workspaceId: true },
  });

  for (const provision of expired) {
    try {
      await deleteProvisionResources(
        provision.id,
        provision.userId,
        provision.workspaceId,
      );
    } catch (err) {
      // One poison row (e.g. a concurrent teardown) must not abort the org's
      // whole sweep — the remaining expired placeholders still get reaped.
      logger.warn(
        { err, provisionId: provision.id },
        "expired-provision teardown failed",
      );
    }
  }
};
