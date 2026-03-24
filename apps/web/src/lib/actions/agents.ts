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

export const getAgents = async () => {
  const { accountId } = await resolveUser();
  return listAgents(accountId);
};

export const getDefaultAgent = async () => {
  const { accountId } = await resolveUser();
  return getDefaultAgentService(accountId);
};

export const createAgent = async (name: string, identifier: string) => {
  const { accountId } = await resolveUser();
  return createAgentService(accountId, name, identifier);
};

export const deleteAgent = async (agentId: string) => {
  const { accountId } = await resolveUser();
  return deleteAgentService(accountId, agentId);
};

export const renameAgent = async (agentId: string, name: string) => {
  const { accountId } = await resolveUser();
  return renameAgentService(accountId, agentId, name);
};

export const regenerateAgentToken = async (agentId: string) => {
  const { accountId } = await resolveUser();
  return regenerateAgentTokenService(accountId, agentId);
};

export const getAgentSecrets = async (agentId: string) => {
  const { accountId } = await resolveUser();
  return getAgentSecretsService(accountId, agentId);
};

export const updateAgentSecretMode = async (
  agentId: string,
  mode: SecretMode,
) => {
  const { accountId } = await resolveUser();
  return updateAgentSecretModeService(accountId, agentId, mode);
};

export const updateAgentSecrets = async (
  agentId: string,
  secretIds: string[],
) => {
  const { accountId } = await resolveUser();
  return updateAgentSecretsService(accountId, agentId, secretIds);
};
