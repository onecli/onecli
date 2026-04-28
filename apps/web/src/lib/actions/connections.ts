"use server";

import { db } from "@onecli/db";
import { resolveUser } from "@/lib/actions/resolve-user";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";
import {
  listConnections,
  listConnectionsByProvider,
  deleteConnection,
} from "@/lib/services/connection-service";

export const getAppConnections = async () => {
  const { projectId } = await resolveUser();
  return listConnections(projectId);
};

export const getAppConnectionsByProvider = async (provider: string) => {
  const { projectId } = await resolveUser();
  return listConnectionsByProvider(projectId, provider);
};

export const getVaultConnections = async () => {
  const { projectId } = await resolveUser();
  return db.vaultConnection.findMany({
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
};

export const disconnectAppConnection = async (connectionId: string) => {
  const { userId, userEmail, projectId } = await resolveUser();

  return withAudit(
    () => deleteConnection(projectId, connectionId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.APP_CONNECTION,
      metadata: { connectionId },
    }),
  );
};
