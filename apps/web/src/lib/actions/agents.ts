"use server";

import { resolveUserId } from "@/lib/actions/resolve-user";
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
  const userId = await resolveUserId();
  return listAgents(userId);
};

export const getDefaultAgent = async () => {
  const userId = await resolveUserId();
  return getDefaultAgentService(userId);
};

export const createAgent = async (name: string, identifier: string) => {
  const userId = await resolveUserId();
  return createAgentService(userId, name, identifier);
};

export const deleteAgent = async (agentId: string) => {
  const userId = await resolveUserId();
  return deleteAgentService(userId, agentId);
};

export const renameAgent = async (agentId: string, name: string) => {
  const userId = await resolveUserId();
  return renameAgentService(userId, agentId, name);
};

export const regenerateAgentToken = async (agentId: string) => {
  const userId = await resolveUserId();
  return regenerateAgentTokenService(userId, agentId);
};

export const getAgentSecrets = async (agentId: string) => {
  const userId = await resolveUserId();
  return getAgentSecretsService(userId, agentId);
};

export const updateAgentSecretMode = async (
  agentId: string,
  mode: SecretMode,
) => {
  const userId = await resolveUserId();
  return updateAgentSecretModeService(userId, agentId, mode);
};

export const updateAgentSecrets = async (
  agentId: string,
  secretIds: string[],
) => {
  const userId = await resolveUserId();
  return updateAgentSecretsService(userId, agentId, secretIds);
};
