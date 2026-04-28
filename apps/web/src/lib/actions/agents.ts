"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import type { SecretMode } from "@/lib/services/agent-service";
import {
  listAgents,
  getDefaultAgent as getDefaultAgentService,
  createAgent as createAgentService,
  deleteAgent as deleteAgentService,
  renameAgent as renameAgentService,
  regenerateAgentToken as regenerateAgentTokenService,
  getAgentSecrets as getAgentSecretsService,
  updateAgentSecretMode as updateAgentSecretModeService,
  updateAgentSecrets as updateAgentSecretsService,
  getAgentAppConnections as getAgentAppConnectionsService,
  updateAgentAppConnections as updateAgentAppConnectionsService,
} from "@/lib/services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const getAgents = async () => {
  const { projectId } = await resolveUser();
  return listAgents(projectId);
};

export const getDefaultAgent = async () => {
  const { projectId } = await resolveUser();
  return getDefaultAgentService(projectId);
};

export const createAgent = async (name: string, identifier: string) => {
  const { userId, userEmail, projectId } = await resolveUser();
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

export const deleteAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveUser();
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
  const { userId, userEmail, projectId } = await resolveUser();
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
  const { userId, userEmail, projectId } = await resolveUser();
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

export const getAgentSecrets = async (agentId: string) => {
  const { projectId } = await resolveUser();
  return getAgentSecretsService(projectId, agentId);
};

export const updateAgentSecretMode = async (
  agentId: string,
  mode: SecretMode,
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => updateAgentSecretModeService(projectId, agentId, mode),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, secretMode: mode },
    }),
  );
};

export const updateAgentSecrets = async (
  agentId: string,
  secretIds: string[],
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => updateAgentSecretsService(projectId, agentId, secretIds),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, secretCount: secretIds.length },
    }),
  );
};

export const getAgentAppConnections = async (agentId: string) => {
  const { projectId } = await resolveUser();
  return getAgentAppConnectionsService(projectId, agentId);
};

export const updateAgentAppConnections = async (
  agentId: string,
  appConnectionIds: string[],
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () =>
      updateAgentAppConnectionsService(projectId, agentId, appConnectionIds),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, appConnectionCount: appConnectionIds.length },
    }),
  );
};
