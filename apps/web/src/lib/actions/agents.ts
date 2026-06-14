"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  listAgents,
  getDefaultAgent as getDefaultAgentService,
  setDefaultAgent as setDefaultAgentService,
  createAgent as createAgentService,
  deleteAgent as deleteAgentService,
  renameAgent as renameAgentService,
  regenerateAgentToken as regenerateAgentTokenService,
} from "@onecli/api/services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getAgents = async () => {
  const { projectId } = await resolveProjectContext();
  return listAgents(projectId);
};

export const getDefaultAgent = async () => {
  const { projectId } = await resolveProjectContext();
  return getDefaultAgentService(projectId);
};

export const createAgent = async (name: string, identifier: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => createAgentService(projectId, name, identifier),
    (agent) => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId: agent.id, name, identifier },
    }),
  );
};

export const setDefaultAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => setDefaultAgentService(projectId, agentId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, change: "set-default" },
    }),
  );
};

export const deleteAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => deleteAgentService(projectId, agentId),
    () => ({
      projectId,
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
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => renameAgentService(projectId, agentId, name),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, name },
    }),
  );
};

export const regenerateAgentToken = async (agentId: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => regenerateAgentTokenService(projectId, agentId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};
