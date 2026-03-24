import { db } from "@onecli/db";

export const getGatewayCounts = async (accountId: string) => {
  const [agents, secrets] = await Promise.all([
    db.agent.count({ where: { accountId } }),
    db.secret.count({ where: { accountId } }),
  ]);

  return { agents, secrets };
};
