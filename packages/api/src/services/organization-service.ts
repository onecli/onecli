import { db } from "@onecli/db";
import { generateApiKey, ensureBootstrapOrgApiKey } from "./api-key-service";
import { generateAccessToken } from "./agent-service";
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_IDENTIFIER } from "../lib/constants";
import { generateProjectId, generateOrganizationId } from "../lib/ids";

export const slugify = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Resolve the user's default project: first organization → first project.
 * Returns null when the user has no organization or no project (pre-bootstrap).
 *
 * Used by `resolveUser()`, `resolveApiAuth()`, and the session route to map
 * an authenticated user to a project without creating anything.
 */
export const findUserDefaultProject = async (
  userId: string,
): Promise<{ id: string; organizationId: string } | null> => {
  const membership = await db.organizationMember.findFirst({
    where: { userId },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) return null;

  return db.project.findFirst({
    where: {
      organizationId: membership.organizationId,
      createdByUserId: userId,
    },
    select: { id: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
};

/**
 * Create an organization with a default project, API key, and default agent
 * for a user who has no organization yet. Returns the created project.
 *
 * This is the single source of truth for the "first login" bootstrap flow.
 * Called by:
 *   - `GET /v1/auth/session` (cloud + OSS)
 *   - `ensureLocalUser()` (OSS local-auth mode)
 *   - `ensureUserDefaultOrgAndProject()` (cloud project management)
 */
export const bootstrapOrganization = async (
  userId: string,
  userEmail: string,
  displayName?: string,
) => {
  const orgName = displayName || userEmail.split("@")[0] || "Personal";
  const baseSlug = slugify(orgName) || "personal";
  const orgSlug = `${baseSlug}-${userId.slice(0, 8)}`;

  const org = await db.organization.create({
    data: {
      id: generateOrganizationId(),
      name: orgName,
      slug: orgSlug,
      members: { create: { userId, userEmail, role: "owner" } },
    },
    select: { id: true },
  });

  const project = await db.project.create({
    data: {
      id: generateProjectId(),
      name: "Default",
      slug: "default",
      organizationId: org.id,
      createdByUserId: userId,
      createdByUserEmail: userEmail,
      apiKeys: { create: { key: generateApiKey(), userId, userEmail } },
      agents: {
        create: {
          name: DEFAULT_AGENT_NAME,
          identifier: DEFAULT_AGENT_IDENTIFIER,
          accessToken: generateAccessToken(),
          isDefault: true,
        },
      },
    },
    select: { id: true, organizationId: true },
  });

  return { project, organization: org };
};

/** The single shared organization for onprem (`single-org-shared` tenancy). */
export const SHARED_ORG_SLUG = "default";
export const SHARED_ORG_NAME = "Default";

/**
 * Find-or-create the single shared organization. The slug is `@unique`, so a
 * concurrent first-login race resolves to one org — the create loser catches the
 * unique violation and re-reads.
 */
const findOrCreateSharedOrg = async (): Promise<{ id: string }> => {
  const existing = await db.organization.findUnique({
    where: { slug: SHARED_ORG_SLUG },
    select: { id: true },
  });
  if (existing) return existing;
  try {
    return await db.organization.create({
      data: {
        id: generateOrganizationId(),
        name: SHARED_ORG_NAME,
        slug: SHARED_ORG_SLUG,
      },
      select: { id: true },
    });
  } catch {
    return db.organization.findUniqueOrThrow({
      where: { slug: SHARED_ORG_SLUG },
      select: { id: true },
    });
  }
};

/**
 * The ORG-LEVEL part of the onprem bootstrap: ensure the single shared
 * organization exists, the user is a member, and the operator bootstrap org API
 * key is seeded — WITHOUT any project. Idempotent and concurrency-safe. Shared by
 * `joinSharedOrganization` (first login) and the eager boot-time init, which
 * provisions just the org + key so the instance is usable via the org key before
 * anyone opens the web.
 */
export const ensureSharedOrgWithKey = async (
  userId: string,
  userEmail: string,
): Promise<{ id: string }> => {
  const org = await findOrCreateSharedOrg();

  // Add the user to the shared org (idempotent on the composite PK).
  await db.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId } },
    create: { organizationId: org.id, userId, userEmail, role: "owner" },
    update: {},
  });

  // Ensure the shared org's bootstrap API key exists (operator-supplied via
  // ONECLI_ORG_API_KEY / _FILE, else generated). Idempotent — no-ops once seeded.
  await ensureBootstrapOrgApiKey({ organizationId: org.id, userId, userEmail });

  return org;
};

/**
 * Single-org (onprem) first-login bootstrap: ensure the shared org + operator key
 * (via `ensureSharedOrgWithKey`), then give the user their own default project
 * inside it. Idempotent and concurrency-safe. Mirrors `bootstrapOrganization`'s
 * return shape — the project apiKey + default agent are seeded by the caller's
 * `ensureProjectSeeds`.
 */
export const joinSharedOrganization = async (
  userId: string,
  userEmail: string,
) => {
  const org = await ensureSharedOrgWithKey(userId, userEmail);

  // Each user gets their own default project in the shared org. The project slug
  // must be unique per org (`@@unique([organizationId, slug])`); since every user
  // shares this one org (unlike the per-user orgs in `bootstrapOrganization`), use
  // the full user id so the slug can never collide.
  let project = await db.project.findFirst({
    where: { organizationId: org.id, createdByUserId: userId },
    select: { id: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!project) {
    project = await db.project.create({
      data: {
        id: generateProjectId(),
        name: "Default",
        slug: `default-${userId}`,
        organizationId: org.id,
        createdByUserId: userId,
        createdByUserEmail: userEmail,
      },
      select: { id: true, organizationId: true },
    });
  }

  return { project, organization: org };
};

export const validateOrgName = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("Organization name must be 1-255 characters");
  }
  return trimmed;
};

/**
 * Ensure a project has an API key for the given user and a default agent.
 * Idempotent — skips creation if they already exist.
 */
export const ensureProjectSeeds = async (
  projectId: string,
  userId: string,
  userEmail: string,
) => {
  const hasKey = await db.apiKey.findFirst({
    where: { userId, projectId },
    select: { id: true },
  });
  if (!hasKey) {
    await db.apiKey.create({
      data: { key: generateApiKey(), userId, userEmail, projectId },
    });
  }

  const hasDefaultAgent = await db.agent.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (!hasDefaultAgent) {
    await db.agent.create({
      data: {
        name: DEFAULT_AGENT_NAME,
        identifier: DEFAULT_AGENT_IDENTIFIER,
        accessToken: generateAccessToken(),
        isDefault: true,
        projectId,
      },
    });
  }
};
