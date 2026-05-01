import { type NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { seedDemoSecret } from "@/lib/services/secret-service";
import {
  findUserDefaultProject,
  bootstrapOrganization,
  ensureProjectSeeds,
} from "@/lib/services/organization-service";
import {
  getSessionAttributes,
  onUserCreated,
  shouldBootstrapOrg,
  augmentSessionResponse,
} from "@/lib/auth/session-hooks";

/**
 * GET /api/auth/session
 *
 * Single endpoint that handles the full auth → DB sync flow:
 * 1. Reads the auth session (cookie/token)
 * 2. Upserts the user in the database
 * 3. Ensures the user has an Organization + Project + ApiKey + Agent
 * 4. Seeds demo secret on first login
 * 5. Returns the user profile with projectId
 *
 * Called by the login page after auth and by the dashboard layout on mount.
 * Returns 401 if no valid session exists.
 */
export const GET = async (request: NextRequest) => {
  try {
    const session = await getServerSession();
    if (!session || !session.email) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const extra = getSessionAttributes(request);

    const existingUser = await db.user.findUnique({
      where: { email: session.email },
      select: { id: true },
    });

    const user = await db.user.upsert({
      where: { email: session.email },
      create: {
        externalAuthId: session.id,
        email: session.email,
        name: session.name,
        lastLoginAt: new Date(),
        ...extra,
      },
      update: {
        externalAuthId: session.id,
        name: session.name,
        lastLoginAt: new Date(),
        ...extra,
      },
      select: { id: true, email: true, name: true },
    });

    let defaultProject = await findUserDefaultProject(user.id);
    let isNewUser = false;

    if (!defaultProject && !existingUser && shouldBootstrapOrg(request)) {
      const result = await bootstrapOrganization(
        user.id,
        user.email,
        user.name ?? undefined,
      );
      defaultProject = result.project;
      isNewUser = true;
      onUserCreated({ email: user.email, name: user.name }, extra);
    }

    if (defaultProject) {
      const projectId = defaultProject.id;
      const organizationId = defaultProject.organizationId;

      await ensureProjectSeeds(projectId, user.id, user.email);

      if (isNewUser) {
        const org = await db.organization.findUnique({
          where: { id: organizationId },
          select: { demoSeeded: true },
        });
        if (org && !org.demoSeeded) {
          await seedDemoSecret(projectId);
          await db.organization.update({
            where: { id: organizationId },
            data: { demoSeeded: true },
          });
        }
      }

      return NextResponse.json({
        id: user.id,
        email: user.email,
        name: user.name,
        projectId,
      });
    }

    const responseExtra = await augmentSessionResponse(user.id);

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      ...responseExtra,
    });
  } catch (err) {
    logger.error(
      { err, route: "GET /api/auth/session" },
      "session sync failed",
    );
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
