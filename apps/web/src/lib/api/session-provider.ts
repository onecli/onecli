import { cookies } from "next/headers";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import type { SessionProvider } from "@onecli/api";

const ACTIVE_PROJECT_COOKIE = "onecli-project-id";

export const nextSessionProvider: SessionProvider = {
  getSession: async () => {
    const session = await getServerSession();
    if (!session) return null;
    return { id: session.id, email: session.email, name: session.name };
  },

  resolveProjectForUser: async (userId: string) => {
    const cookieStore = await cookies();
    const cookieProjectId = cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value;

    if (!cookieProjectId) return null;

    const memberOrgIds = await db.user
      .findUnique({
        where: { id: userId },
        select: {
          organizationMemberships: {
            select: { organizationId: true },
          },
        },
      })
      .then(
        (u) => u?.organizationMemberships.map((m) => m.organizationId) ?? [],
      );

    const project = await db.project.findFirst({
      where: {
        id: cookieProjectId,
        organizationId: { in: memberOrgIds },
      },
      select: { id: true },
    });

    return project?.id ?? null;
  },
};
