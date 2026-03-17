import { db } from "@onecli/db";

export const getGatewayCounts = async (userId: string) => {
  const [agents, secrets] = await Promise.all([
    db.agent.count({ where: { userId } }),
    db.secret.count({ where: { userId } }),
  ]);

  return { agents, secrets };
};
