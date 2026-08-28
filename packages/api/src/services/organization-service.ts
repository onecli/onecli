import { db, Prisma } from "@onecli/db";
import { generateApiKey } from "./api-key-service";
import { generateWorkspaceId, generateOrganizationId } from "../lib/ids";
import { getNewOrgPolicySeeder } from "../providers";
import { logger } from "../lib/logger";
import {
  validateDisplayName,
  DISPLAY_NAME_MAX_LEN,
} from "../validations/display-name";

export const slugify = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The name an auto-created workspace is born with: the owner's display name,
 * falling back to their email (clamped) when the name is missing or wouldn't
 * pass the workspace-name rules. The single naming law for every provision
 * site (bootstrap, member provisioning, org-switch auto-create) — never a
 * generic "Default" again.
 *
 * The output always satisfies `validateDisplayName`, so it can be fed to the
 * validating create paths without ever throwing. The truthiness guards matter:
 * `validateDisplayName("")` is `null` (valid) by design — empty means
 * "optional field not provided" to the UI — so emptiness must be rejected
 * here explicitly.
 */
export const workspaceNameForOwner = (
  ownerName: string | null | undefined,
  ownerEmail: string,
): string => {
  const name = (ownerName ?? "").trim();
  if (name && validateDisplayName(name) === null) return name;
  const email = ownerEmail
    .trim()
    .slice(0, DISPLAY_NAME_MAX_LEN)
    // The clamp counts UTF-16 units; drop a split surrogate pair's leftover
    // high half so an SMTPUTF8 email can never yield an ill-formed name.
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
  if (email && validateDisplayName(email) === null) return email;
  return "Personal";
};

/**
 * Membership filter every ACCESS-GRANTING read applies: suspended members are
 * treated as non-members by all authorization checks (the write-side lives in
 * the EE team service; nothing sets "suspended" in OSS, so this is inert
 * there). Deliberately NOT applied to display lists, seat counts, or the
 * provisioning/JIT existence guards — filtering those would re-mint
 * memberships for suspended users.
 */
export const activeMembershipWhere = {
  status: { not: "suspended" },
} as const;

/**
 * Resolve the user's default workspace: first organization → first workspace.
 * Returns null when the user has no organization or no workspace (pre-bootstrap).
 *
 * Used by `resolveUser()`, `resolveApiAuth()`, and the session route to map
 * an authenticated user to a workspace without creating anything.
 */
export const findUserDefaultWorkspace = async (
  userId: string,
  client: Prisma.TransactionClient = db,
): Promise<{ id: string; organizationId: string } | null> => {
  const membership = await client.organizationMember.findFirst({
    where: { userId, ...activeMembershipWhere },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) return null;

  return client.workspace.findFirst({
    where: {
      organizationId: membership.organizationId,
      createdByUserId: userId,
    },
    select: { id: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
};

/**
 * The nested-write seeds every user-facing workspace is born with: one API key.
 * The single definition all provision sites spread into their `workspace.create`
 * data (bootstrap, workspace creation, membership provisioning) — the guarded
 * split-write variant for existing workspaces is `ensureWorkspaceSeeds` below.
 *
 * No agent is seeded: a workspace starts empty and the user creates the agents
 * they want. Seeding one handed out a token nobody asked for, and the flag
 * that marked it made it undeletable.
 */
export const defaultWorkspaceSeed = (userId: string, userEmail: string) => ({
  apiKeys: { create: { key: generateApiKey(), userId, userEmail } },
});

/** The naming derivations every org-bootstrap arm shares. */
const bootstrapNames = (
  userId: string,
  userEmail: string,
  ownerName: string | null | undefined,
  displayName?: string,
) => {
  const orgName = displayName || userEmail.split("@")[0] || "Personal";
  const baseSlug = slugify(orgName) || "personal";
  return {
    orgName,
    orgSlug: `${baseSlug}-${userId.slice(0, 8)}`,
    workspaceName: workspaceNameForOwner(ownerName, userEmail),
  };
};

/**
 * The slug a user's workspace gets when it is born into an org WITH history
 * (member provisioning, the bootstrap repair arm): the userId suffix keeps the
 * per-org slug unique even when two same-named members join the same org.
 */
const userSuffixedSlug = (workspaceName: string, userId: string) =>
  `${slugify(workspaceName) || "workspace"}-${userId.slice(0, 8)}`;

/**
 * The data block a user's own default workspace is born from — shared by the
 * fresh create (nested under the org), the repair arm, and member
 * provisioning, so the shapes can never drift.
 */
const ownerWorkspaceData = (
  userId: string,
  userEmail: string,
  workspaceName: string,
  slug: string,
) => ({
  id: generateWorkspaceId(),
  name: workspaceName,
  slug,
  createdByUserId: userId,
  createdByUserEmail: userEmail,
  ...defaultWorkspaceSeed(userId, userEmail),
  // Creator's WorkspaceAccess binding (step 13), seeded owner (13c) with the
  // workspace. Inert in OSS (nothing reads bindings without RBAC); load-bearing
  // in cloud.
  accessBindings: { create: { userId, role: "owner" } },
});

/**
 * The one statement that brings a user's organization into existence: org,
 * owner membership and default workspace as a single nested create, atomic by
 * Prisma's nested-write guarantee. A crash or a lost race can no longer leave
 * a membership without its workspace — the state that used to wedge every
 * subsequent session sync on the org-slug unique constraint.
 */
const createOrgWithDefaultWorkspace = async (
  client: Prisma.TransactionClient,
  args: {
    userId: string;
    userEmail: string;
    orgName: string;
    orgSlug: string;
    workspaceName: string;
  },
) => {
  const { userId, userEmail, orgName, orgSlug, workspaceName } = args;
  const org = await client.organization.create({
    data: {
      id: generateOrganizationId(),
      name: orgName,
      slug: orgSlug,
      members: { create: { userId, userEmail, role: "owner" } },
      workspaces: {
        create: ownerWorkspaceData(
          userId,
          userEmail,
          workspaceName,
          // The org is brand new, so the bare slug cannot collide. The fallback
          // only matters if the naming rules ever loosen past slugify's alphabet.
          slugify(workspaceName) || "workspace",
        ),
      },
    },
    select: {
      id: true,
      workspaces: { select: { id: true, organizationId: true } },
    },
  });
  // Just created with exactly one nested workspace.
  return { workspace: org.workspaces[0]!, organization: { id: org.id } };
};

/**
 * Create an organization with a default workspace and API key for a user who has
 * no organization yet. Returns the created workspace.
 *
 * Direct callers:
 *   - `createOrganization()` (EE "New organization" flow) — which RELIES on a
 *     P2002 slug collision propagating from here to answer 409 for a
 *     duplicate org name; never swallow it.
 * The auto-provision sites (`GET /v1/auth/session`,
 * `resolveAuthenticatedUser()`) go through `ensureUserOrganization` below,
 * which serializes concurrent syncs and converges instead of throwing.
 *
 * `displayName` names the ORGANIZATION only (the "New organization" flow
 * passes the user-typed org name here, not the person's name). The workspace
 * is named after the owner, whose display name is read from their user row —
 * always present by the time any caller runs.
 */
export const bootstrapOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
) => {
  const owner = await db.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const names = bootstrapNames(userId, userEmail, owner?.name, displayName);

  const result = await createOrgWithDefaultWorkspace(db, {
    userId,
    userEmail,
    ...names,
  });

  await seedNewOrgPolicy(result.organization.id, result.workspace.id);
  return result;
};

/**
 * Seed a new org's initial published policy (cloud: an allow-posture org
 * Default Rule). Best-effort — a hiccup must not fail onboarding; the org then
 * has no published generation and the engine allows until one is authored. OSS
 * default is a no-op. Must run AFTER the bootstrap commit: the seeder opens
 * its own transaction and advisory lock.
 */
const seedNewOrgPolicy = async (
  organizationId: string,
  workspaceId: string,
) => {
  try {
    await getNewOrgPolicySeeder().seed(organizationId, workspaceId);
  } catch (err) {
    logger.warn({ err, organizationId }, "new-org policy seed failed");
  }
};

/**
 * Advisory-lock key serializing one user's auto-provisioning. Exported so the
 * proof suite can hold the lock and pin the blocked-then-converge interleaving.
 */
export const orgBootstrapLockKey = (userId: string) =>
  `org-bootstrap:${userId}`;

export interface EnsuredOrganization {
  organization: { id: string };
  workspace: { id: string; organizationId: string };
  /**
   * Whether THIS call bootstrapped a brand-new organization. The session route
   * feeds it to `onUserCreated` — a converging loser or a repair must not
   * re-announce a signup (duplicate welcome email).
   */
  created: boolean;
}

/**
 * Ensure a user has an organization and their default workspace — the
 * concurrency-safe, self-healing entry point for the auto-provision sites.
 *
 * Concurrent session syncs for the same user (signup redirect + dashboard
 * mount, two tabs) used to race `bootstrapOrganization` into a P2002 on the
 * deterministic org slug and surface as a 500 on first registration. Here the
 * per-user advisory lock serializes them, and whoever loses the race simply
 * converges on the winner's rows.
 *
 * Arms, checked under the lock:
 *  - converge: the default workspace exists → return it, create nothing;
 *  - repair: the exact crashed-bootstrap state (owner membership whose org
 *    has ZERO workspaces — org+membership commit was atomic, the workspace
 *    write never ran; only pre-atomicity databases can carry it) → create
 *    just the missing workspace;
 *  - fresh: no active membership → full bootstrap.
 * Any other membership-without-workspace shape (deleted workspaces, multi-org
 * members) deliberately falls through to fresh — minting resources inside an
 * org an admin manages is not this function's call.
 */
export const ensureUserOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
): Promise<EnsuredOrganization> => {
  const owner = await db.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const names = bootstrapNames(userId, userEmail, owner?.name, displayName);

  let outcome: EnsuredOrganization & { seed: boolean };
  try {
    outcome = await db.$transaction(
      async (tx) => {
        // Serialize per user. Everything below re-reads AFTER the lock is
        // granted, which under READ COMMITTED (the Postgres default — do not
        // pass an isolationLevel here) sees a concurrent winner's commit; a
        // stricter level would pin the snapshot to before the wait and
        // re-create the race this exists to end.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgBootstrapLockKey(userId)}))`;

        const existing = await findUserDefaultWorkspace(userId, tx);
        if (existing) {
          return {
            workspace: existing,
            organization: { id: existing.organizationId },
            created: false,
            seed: false,
          };
        }

        const membership = await tx.organizationMember.findFirst({
          where: { userId, ...activeMembershipWhere },
          select: { organizationId: true, role: true },
          orderBy: { createdAt: "asc" },
        });
        if (membership?.role === "owner") {
          const workspaces = await tx.workspace.count({
            where: { organizationId: membership.organizationId },
          });
          if (workspaces === 0) {
            const workspace = await tx.workspace.create({
              data: {
                ...ownerWorkspaceData(
                  userId,
                  userEmail,
                  names.workspaceName,
                  // Unlike the fresh arm's brand-new org, this org has history.
                  userSuffixedSlug(names.workspaceName, userId),
                ),
                organizationId: membership.organizationId,
              },
              select: { id: true, organizationId: true },
            });
            return {
              workspace,
              organization: { id: membership.organizationId },
              // The crashed bootstrap never reached the seeder (it runs last),
              // so the repaired org still needs its policy seed.
              created: false,
              seed: true,
            };
          }
        }

        const result = await createOrgWithDefaultWorkspace(tx, {
          userId,
          userEmail,
          ...names,
        });
        return { ...result, created: true, seed: true };
      },
      // The loser's lock wait burns its own transaction budget; Prisma's 5s
      // default is too tight for a cold-start winner (policy-service precedent).
      { timeout: 15_000, maxWait: 5_000 },
    );
  } catch (err) {
    // A unique-constraint loss can still happen against writers that don't
    // take the lock (EE createOrganization, invitation accept, JIT, claim).
    // The transaction is already aborted, so recovery must happen out here:
    // if the user now has a default workspace, that IS the converged answer.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await findUserDefaultWorkspace(userId);
      if (existing) {
        return {
          workspace: existing,
          organization: { id: existing.organizationId },
          created: false,
        };
      }
    }
    throw err;
  }

  if (outcome.seed) {
    await seedNewOrgPolicy(
      outcome.workspace.organizationId,
      outcome.workspace.id,
    );
  }
  return {
    workspace: outcome.workspace,
    organization: outcome.organization,
    created: outcome.created,
  };
};

export const validateOrgName = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("Organization name must be 1-255 characters");
  }
  return trimmed;
};

/**
 * Ensure a workspace has an API key for the given user. Idempotent — skips
 * creation if one already exists. No agent is seeded (see
 * `defaultWorkspaceSeed`).
 */
export const ensureWorkspaceSeeds = async (
  workspaceId: string,
  userId: string,
  userEmail: string,
) => {
  // `kind: "user"`: a service key (a channel presence's approvals key) must not
  // count as the user's personal key, or seeding would skip minting the real
  // one and the user would be left without a usable key when the service key is
  // later revoked.
  const hasKey = await db.apiKey.findFirst({
    where: { userId, workspaceId, kind: "user" },
    select: { id: true },
  });
  if (!hasKey) {
    await db.apiKey.create({
      data: { key: generateApiKey(), userId, userEmail, workspaceId },
    });
  }
};

/**
 * The transactional ops that make a user an org member with their own
 * default workspace (+ API key). Shared by invitation accept
 * and SSO JIT joins — run inside one db.$transaction so a member row can
 * never exist without its workspace.
 */
export const memberProvisionOps = (
  organizationId: string,
  userId: string,
  userEmail: string,
  role: string,
  ownerName: string | null,
) => {
  const workspaceName = workspaceNameForOwner(ownerName, userEmail);
  return [
    db.organizationMember.create({
      data: {
        organizationId,
        userId,
        userEmail,
        role,
      },
    }),
    db.workspace.create({
      data: {
        ...ownerWorkspaceData(
          userId,
          userEmail,
          workspaceName,
          userSuffixedSlug(workspaceName, userId),
        ),
        organizationId,
      },
    }),
  ] as const;
};

/**
 * The roles a member may be given, whether by invitation or by a later role
 * change. `owner` is deliberately absent: it is conferred by creating the
 * organization, never assigned.
 */
export const ASSIGNABLE_MEMBER_ROLES = new Set(["admin", "member"]);
