"use server";

import { randomBytes } from "crypto";
import { db } from "@onecli/db";
import { resolveUserId } from "@/lib/actions/resolve-user";

const generateAccessToken = () => `aoc_${randomBytes(32).toString("hex")}`;

export async function getAgents() {
  const userId = await resolveUserId();

  return db.agent.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      accessToken: true,
      isDefault: true,
      secretMode: true,
      createdAt: true,
      _count: { select: { agentSecrets: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function getDefaultAgent() {
  const userId = await resolveUserId();

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

export async function getAgentSecrets(agentId: string) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  const rows = await db.agentSecret.findMany({
    where: { agentId },
    select: { secretId: true },
  });

  return rows.map((r) => r.secretId);
}

export async function updateAgentSecretMode(
  agentId: string,
  mode: "all" | "selective",
) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  await db.agent.update({
    where: { id: agentId },
    data: { secretMode: mode },
  });
}

export async function updateAgentSecrets(agentId: string, secretIds: string[]) {
  const userId = await resolveUserId();

  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });

  if (!agent) throw new Error("Agent not found");

  // Validate all secrets belong to this user
  const secrets = await db.secret.findMany({
    where: { id: { in: secretIds }, userId },
    select: { id: true },
  });

  const validIds = new Set(secrets.map((s) => s.id));
  const invalid = secretIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new Error("One or more secrets not found");
  }

  await db.$transaction([
    db.agentSecret.deleteMany({ where: { agentId } }),
    ...secretIds.map((secretId) =>
      db.agentSecret.create({ data: { agentId, secretId } }),
    ),
  ]);
}
