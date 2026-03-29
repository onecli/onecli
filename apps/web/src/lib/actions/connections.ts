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
  deleteConnection,
} from "@/lib/services/connection-service";

export const getAppConnections = async () => {
  const { accountId } = await resolveUser();
  return listConnections(accountId);
};

export const getVaultConnections = async () => {
  const { accountId } = await resolveUser();
  return db.vaultConnection.findMany({
    where: { accountId },
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

export const disconnectApp = async (provider: string) => {
  const { userId, userEmail, accountId } = await resolveUser();

  return withAudit(
    () => deleteConnection(accountId, provider),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.APP_CONNECTION,
      metadata: { provider },
    }),
  );
};
