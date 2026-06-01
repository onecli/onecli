"use server";

import "@/lib/init/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { findUserDefaultProject } from "@onecli/api/services/organization-service";

export interface UserContext {
  userId: string;
  userEmail: string;
  organizationId: string;
  projectId: string;
}

/**
 * Resolves the current authenticated user's ID, their organization, and the
 * active project. Always validates the session server-side — never trusts
 * client input.
 */
export const resolveProjectContext = async (): Promise<UserContext> => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true },
  });

  if (!user) throw new Error("User not found");

  const project = await findUserDefaultProject(user.id);
  if (!project) throw new Error("No project found");

  return {
    userId: user.id,
    userEmail: user.email,
    organizationId: project.organizationId,
    projectId: project.id,
  };
};
