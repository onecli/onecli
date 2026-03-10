"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

const generateAccessToken = () => `oat_${randomBytes(32).toString("hex")}`;
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

async function resolveUserId(authId?: string): Promise<string> {
  let id = authId;
  if (!id) {
    const session = await getServerSession();
    if (!session) throw new Error("Not authenticated");
    id = session.id;
  }

  const user = await db.user.findUnique({
    where: { cognitoId: id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");
  return user.id;
}

export async function getAgents(authId?: string) {
  const userId = await resolveUserId(authId);
  await ensureDefaultAgent(userId);

  return db.agent.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      accessToken: true,
      isDefault: true,
      createdAt: true,
      _count: { select: { policies: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function getDefaultAgent(authId?: string) {
  const userId = await resolveUserId(authId);
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

export async function createAgent(name: string, authId?: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new Error("Name must be between 1 and 255 characters");
  }

  const userId = await resolveUserId(authId);
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

export async function deleteAgent(agentId: string, authId?: string) {
  const userId = await resolveUserId(authId);

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true, isDefault: true },
  });

  if (!agent) throw new Error("Agent not found");
  if (agent.isDefault) throw new Error("Cannot delete the default agent");

  await db.agent.delete({ where: { id: agentId } });
}

export async function regenerateAgentToken(agentId: string, authId?: string) {
  const userId = await resolveUserId(authId);

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
