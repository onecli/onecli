import { db } from "@onecli/db";

export const getResourceCounts = async (
  projectId: string,
  organizationId?: string,
) => {
  const secretWhere = (type: "generic" | "non-generic") => {
    const typeFilter =
      type === "generic"
        ? { type: "generic" as const }
        : { type: { not: "generic" } };
    if (!organizationId) return { projectId, ...typeFilter };
    return {
      OR: [
        { projectId, ...typeFilter },
        { organizationId, scope: "organization", ...typeFilter },
      ],
    };
  };

  const appWhere = organizationId
    ? {
        OR: [
          { projectId, status: "connected" },
          { organizationId, scope: "organization", status: "connected" },
        ],
      }
    : { projectId, status: "connected" };

  const [agents, apps, llms, secrets] = await Promise.all([
    db.agent.count({ where: { projectId } }),
    db.appConnection.count({ where: appWhere }),
    db.secret.count({ where: secretWhere("non-generic") }),
    db.secret.count({ where: secretWhere("generic") }),
  ]);

  return { agents, apps, llms, secrets };
};
