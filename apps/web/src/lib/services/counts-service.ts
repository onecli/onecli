import { db } from "@onecli/db";

export const getGatewayCounts = async (projectId: string) => {
  const [agents, secrets] = await Promise.all([
    db.agent.count({ where: { projectId } }),
    db.secret.count({ where: { projectId } }),
  ]);

  return { agents, secrets };
};
