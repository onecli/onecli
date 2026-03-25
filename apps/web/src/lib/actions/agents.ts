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
} from "@/lib/services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const getAgents = async () => {
  const { accountId } = await resolveUser();
  return listAgents(accountId);
};

export const getDefaultAgent = async () => {
  const { accountId } = await resolveUser();
  return getDefaultAgentService(accountId);
};

export const createAgent = async (name: string, identifier: string) => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => createAgentService(accountId, name, identifier),
    (agent) => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId: agent.id, name, identifier },
    }),
  );
};

export const deleteAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => deleteAgentService(accountId, agentId),
    () => ({
      accountId,
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
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => renameAgentService(accountId, agentId, name),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, name },
    }),
  );
};

export const regenerateAgentToken = async (agentId: string) => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => regenerateAgentTokenService(accountId, agentId),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};

export const getAgentSecrets = async (agentId: string) => {
  const { accountId } = await resolveUser();
  return getAgentSecretsService(accountId, agentId);
};

export const updateAgentSecretMode = async (
  agentId: string,
  mode: SecretMode,
): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => updateAgentSecretModeService(accountId, agentId, mode),
    () => ({
      accountId,
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
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => updateAgentSecretsService(accountId, agentId, secretIds),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, secretCount: secretIds.length },
    }),
  );
};
