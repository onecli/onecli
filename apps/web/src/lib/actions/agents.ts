"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import {
  deleteAgent as deleteAgentService,
  updateAgent as updateAgentService,
} from "@onecli/api/services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const deleteAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => deleteAgentService(workspaceId, agentId),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};

export const renameAgent = async (
  agentId: string,
  name: string,
): Promise<void> => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => updateAgentService(workspaceId, agentId, { name }),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, name },
    }),
  );
};
