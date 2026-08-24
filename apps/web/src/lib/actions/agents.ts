"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import {
  listAgents,
  deleteAgent as deleteAgentService,
  updateAgent as updateAgentService,
  regenerateAgentToken as regenerateAgentTokenService,
} from "@onecli/api/services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getAgents = async () => {
  const { workspaceId } = await resolveWorkspaceContext();
  return listAgents(workspaceId);
};

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

export const regenerateAgentToken = async (agentId: string) => {
  const { userId, userEmail, workspaceId } = await resolveWorkspaceContext();
  return withAudit(
    () => regenerateAgentTokenService(workspaceId, agentId),
    () => ({
      workspaceId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};
