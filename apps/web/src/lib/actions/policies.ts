"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";

const resolveUserId = async (authId?: string) => {
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
};

export async function getPolicies(authId?: string) {
  const userId = await resolveUserId(authId);

  return db.policy.findMany({
    where: { userId },
    select: {
      id: true,
      createdAt: true,
      agent: {
        select: { id: true, name: true },
      },
      secret: {
        select: { id: true, name: true, type: true, hostPattern: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAgentsAndSecrets(authId?: string) {
  const userId = await resolveUserId(authId);

  const [agents, secrets] = await Promise.all([
    db.agent.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.secret.findMany({
      where: { userId },
      select: { id: true, name: true, type: true, hostPattern: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return { agents, secrets };
}

export async function createPolicy(
  agentId: string,
  secretId: string,
  authId?: string,
) {
  const userId = await resolveUserId(authId);

  // Verify both agent and secret belong to this user
  const [agent, secret] = await Promise.all([
    db.agent.findFirst({
      where: { id: agentId, userId },
      select: { id: true },
    }),
    db.secret.findFirst({
      where: { id: secretId, userId },
      select: { id: true },
    }),
  ]);

  if (!agent) throw new Error("Agent not found");
  if (!secret) throw new Error("Secret not found");

  // Check for duplicate
  const existing = await db.policy.findUnique({
    where: { agentId_secretId: { agentId, secretId } },
    select: { id: true },
  });

  if (existing) throw new Error("This policy already exists");

  return db.policy.create({
    data: { agentId, secretId, userId },
    select: {
      id: true,
      createdAt: true,
      agent: { select: { id: true, name: true } },
      secret: {
        select: { id: true, name: true, type: true, hostPattern: true },
      },
    },
  });
}

export async function deletePolicy(policyId: string, authId?: string) {
  const userId = await resolveUserId(authId);

  const policy = await db.policy.findFirst({
    where: { id: policyId, userId },
    select: { id: true },
  });

  if (!policy) throw new Error("Policy not found");

  await db.policy.delete({ where: { id: policyId } });
}

export async function updatePolicy(
  policyId: string,
  data: { agentId?: string; secretId?: string },
  authId?: string,
) {
  const userId = await resolveUserId(authId);

  const policy = await db.policy.findFirst({
    where: { id: policyId, userId },
    select: { id: true, agentId: true, secretId: true },
  });

  if (!policy) throw new Error("Policy not found");

  const newAgentId = data.agentId ?? policy.agentId;
  const newSecretId = data.secretId ?? policy.secretId;

  // Verify ownership of new agent/secret
  if (data.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, userId },
      select: { id: true },
    });
    if (!agent) throw new Error("Agent not found");
  }

  if (data.secretId) {
    const secret = await db.secret.findFirst({
      where: { id: data.secretId, userId },
      select: { id: true },
    });
    if (!secret) throw new Error("Secret not found");
  }

  // Check for duplicate with new combination
  if (data.agentId || data.secretId) {
    const existing = await db.policy.findUnique({
      where: {
        agentId_secretId: { agentId: newAgentId, secretId: newSecretId },
      },
      select: { id: true },
    });
    if (existing && existing.id !== policyId) {
      throw new Error("This policy already exists");
    }
  }

  return db.policy.update({
    where: { id: policyId },
    data: { agentId: newAgentId, secretId: newSecretId },
    select: {
      id: true,
      createdAt: true,
      agent: { select: { id: true, name: true } },
      secret: {
        select: { id: true, name: true, type: true, hostPattern: true },
      },
    },
  });
}
