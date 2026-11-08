import { db } from "@onecli/db";

export const getResourceCounts = async (
  workspaceId: string,
  organizationId?: string,
) => {
  const secretWhere = (type: "generic" | "non-generic") => {
    const typeFilter =
      type === "generic"
        ? { type: "generic" as const }
        : { type: { not: "generic" } };
    if (!organizationId) return { workspaceId, ...typeFilter };
    return {
      OR: [
        { workspaceId, ...typeFilter },
        { organizationId, scope: "organization", ...typeFilter },
      ],
    };
  };

  const appWhere = organizationId
    ? {
        OR: [
          { workspaceId, status: "connected" },
          { organizationId, scope: "organization", status: "connected" },
        ],
      }
    : { workspaceId, status: "connected" };

  const [agents, apps, llms, secrets] = await Promise.all([
    db.agent.count({ where: { workspaceId } }),
    db.appConnection.count({ where: appWhere }),
    db.secret.count({ where: secretWhere("non-generic") }),
    db.secret.count({ where: secretWhere("generic") }),
  ]);

  return { agents, apps, llms, secrets };
};
