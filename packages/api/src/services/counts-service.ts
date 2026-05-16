import { db } from "@onecli/db";

export const getGatewayCounts = async (projectId: string) => {
  const [agents, apps, llms, secrets] = await Promise.all([
    db.agent.count({ where: { projectId } }),
    db.appConnection.count({
      where: { projectId, status: "connected" },
    }),
    db.secret.count({ where: { projectId, type: { not: "generic" } } }),
    db.secret.count({ where: { projectId, type: "generic" } }),
  ]);

  return { agents, apps, llms, secrets };
};
