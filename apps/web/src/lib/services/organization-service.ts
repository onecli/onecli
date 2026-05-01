import { db } from "@onecli/db";
import { generateApiKey } from "@/lib/services/api-key-service";
import { generateAccessToken } from "@/lib/services/agent-service";
import { DEFAULT_AGENT_NAME } from "@/lib/constants";
import { generateProjectId, generateOrganizationId } from "@/lib/ids";

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
 *   - `GET /api/auth/session` (cloud + OSS)
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
    select: { id: true, demoSeeded: true },
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
          accessToken: generateAccessToken(),
          isDefault: true,
        },
      },
    },
    select: { id: true, organizationId: true },
  });

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
        accessToken: generateAccessToken(),
        isDefault: true,
        projectId,
      },
    });
  }
};
