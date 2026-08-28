import { db } from "@onecli/db";

// Vault connections are workspace-only (the model has no org scope columns), so
// this takes a plain workspaceId like agent-service rather than a ResourceScope.
export const listVaultConnections = async (workspaceId: string) =>
  db.vaultConnection.findMany({
    where: { workspaceId },
    select: {
      id: true,
      provider: true,
      status: true,
      name: true,
      lastConnectedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
