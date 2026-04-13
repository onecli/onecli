"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { resolveUserId } from "./resolve-user";

const generateAccessToken = () => `aoc_${randomBytes(32).toString("hex")}`;
const DEFAULT_AGENT_NAME = "Default Agent";

async function ensureDefaultAgent(userId: string) {
  const existing = await db.agent.findFirst({
    where: { userId, isDefault: true },
    select: { id: true },
  });

  if (!existing) {
    await db.agent.create({
      data: {
        name: DEFAULT_AGENT_NAME,
        accessToken: generateAccessToken(),
        isDefault: true,
        userId,
      },
    });
  }
}

export async function getAgents() {
  const userId = await resolveUserId();
  await ensureDefaultAgent(userId);

  const agents = await db.agent.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      accessToken: true,
      isDefault: true,
      createdAt: true,
      _count: {
        select: {
          secretBindings: true,
        },
      },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });

  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    accessToken: agent.accessToken,
    isDefault: agent.isDefault,
    createdAt: agent.createdAt,
    secretCount: agent._count.secretBindings,
  }));
}

export async function getDefaultAgent() {
  const userId = await resolveUserId();
  await ensureDefaultAgent(userId);

  return db.agent.findFirst({
    where: { userId, isDefault: true },
    select: {
      id: true,
      name: true,
      accessToken: true,
      isDefault: true,
      createdAt: true,
    },
  });
}

export async function createAgent(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("Name must be between 1 and 255 characters");
  }

  const userId = await resolveUserId();
  const accessToken = generateAccessToken();

  const agent = await db.agent.create({
    data: {
      name: trimmed,
      accessToken,
      userId,
    },
    select: {
      id: true,
      name: true,
      accessToken: true,
      createdAt: true,
    },
  });

  return agent;
}

export async function getAgentSecretAssignments(agentId: string) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  const secrets = await db.secret.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      type: true,
      hostPattern: true,
      pathPattern: true,
      agentBindings: {
        where: { agentId },
        select: { agentId: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return secrets.map((secret) => ({
    id: secret.id,
    name: secret.name,
    type: secret.type,
    hostPattern: secret.hostPattern,
    pathPattern: secret.pathPattern,
    assigned: secret.agentBindings.length > 0,
  }));
}

export async function setAgentSecretAssignments(
  agentId: string,
  secretIds: string[],
) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  const uniqueSecretIds = [...new Set(secretIds)];

  if (uniqueSecretIds.length === 0) {
    throw new Error("At least one secret must be assigned to an agent");
  }

  const ownedSecrets = await db.secret.findMany({
    where: {
      userId,
      id: { in: uniqueSecretIds },
    },
    select: { id: true },
  });

  if (ownedSecrets.length !== uniqueSecretIds.length) {
    throw new Error("One or more secrets do not belong to this user");
  }

  await db.$transaction(async (tx) => {
    await tx.agentSecretBinding.deleteMany({ where: { agentId } });

    await tx.agentSecretBinding.createMany({
      data: uniqueSecretIds.map((secretId) => ({ agentId, secretId })),
      skipDuplicates: true,
    });
  });
}

export async function deleteAgent(agentId: string) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true, isDefault: true },
  });

  if (!agent) throw new Error("Agent not found");
  if (agent.isDefault) throw new Error("Cannot delete the default agent");

  await db.agent.delete({ where: { id: agentId } });
}

export async function regenerateAgentToken(agentId: string) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  const accessToken = generateAccessToken();

  const updated = await db.agent.update({
    where: { id: agentId },
    data: { accessToken },
    select: { accessToken: true },
  });

  return { accessToken: updated.accessToken };
}
