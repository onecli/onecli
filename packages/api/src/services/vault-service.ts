import { db } from "@onecli/db";

// Vault connections are project-only (the model has no org scope columns), so
// this takes a plain projectId like agent-service rather than a ResourceScope.
export const listVaultConnections = async (projectId: string) =>
  db.vaultConnection.findMany({
    where: { projectId },
    select: {
      id: true,
      provider: true,
      status: true,
      name: true,
      lastConnectedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
