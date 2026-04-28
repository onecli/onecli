import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "@/lib/services/errors";
import { IDENTIFIER_REGEX } from "@/lib/validations/agent";

export type SecretMode = "all" | "selective";

export const generateAccessToken = () =>
  `aoc_${randomBytes(32).toString("hex")}`;

export const listAgents = async (projectId: string) => {
  const agents = await db.agent.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      identifier: true,
      accessToken: true,
      isDefault: true,
      secretMode: true,
      createdAt: true,
      _count: { select: { agentSecrets: true, agentAppConnections: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });

  return agents.map((a) => ({
    ...a,
    secretMode: a.secretMode as SecretMode,
  }));
};

export const getDefaultAgent = async (projectId: string) => {
  return db.agent.findFirst({
    where: { projectId, isDefault: true },
    select: {
      id: true,
      name: true,
      accessToken: true,
      isDefault: true,
      createdAt: true,
    },
  });
};

export const createAgent = async (
  projectId: string,
  name: string,
  identifier: string,
) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  const trimmedIdentifier = identifier.trim();
  if (!IDENTIFIER_REGEX.test(trimmedIdentifier)) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Identifier must be 1-50 characters, start with a letter, and contain only lowercase letters, numbers, and hyphens",
    );
  }

  const existing = await db.agent.findFirst({
    where: { projectId, identifier: trimmedIdentifier },
    select: { id: true },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      "An agent with this identifier already exists",
    );
  }

  const accessToken = generateAccessToken();

  try {
    const agent = await db.agent.create({
      data: {
        name: trimmed,
        identifier: trimmedIdentifier,
        accessToken,
        secretMode: "all",
        projectId,
      },
      select: {
        id: true,
        name: true,
        identifier: true,
        createdAt: true,
      },
    });

    // Auto-assign the first anthropic secret if one exists
    const anthropicSecret = await db.secret.findFirst({
      where: { projectId, type: "anthropic" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    if (anthropicSecret) {
      await db.agentSecret.create({
        data: { agentId: agent.id, secretId: anthropicSecret.id },
      });
    }

    return agent;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "An agent with this identifier already exists",
      );
    }
    throw err;
  }
};

export const deleteAgent = async (projectId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true, isDefault: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.isDefault)
    throw new ServiceError("BAD_REQUEST", "Cannot delete the default agent");

  await db.agent.delete({ where: { id: agentId } });
};

export const renameAgent = async (
  projectId: string,
  agentId: string,
  name: string,
) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  await db.agent.update({
    where: { id: agentId },
    data: { name: trimmed },
  });
};

export const regenerateAgentToken = async (
  projectId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const accessToken = generateAccessToken();

  const updated = await db.agent.update({
    where: { id: agentId },
    data: { accessToken },
    select: { accessToken: true },
  });

  return { accessToken: updated.accessToken };
};

export const getAgentSecrets = async (projectId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const rows = await db.agentSecret.findMany({
    where: { agentId },
    select: { secretId: true },
  });

  return rows.map((r) => r.secretId);
};

export const updateAgentSecretMode = async (
  projectId: string,
  agentId: string,
  mode: SecretMode,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  await db.agent.update({
    where: { id: agentId },
    data: { secretMode: mode },
  });
};

export const updateAgentSecrets = async (
  projectId: string,
  agentId: string,
  secretIds: string[],
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  // Validate all secrets belong to this account
  const secrets = await db.secret.findMany({
    where: { id: { in: secretIds }, projectId },
    select: { id: true },
  });

  const validIds = new Set(secrets.map((s) => s.id));
  const invalid = secretIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ServiceError("BAD_REQUEST", "One or more secrets not found");
  }

  await db.$transaction([
    db.agentSecret.deleteMany({ where: { agentId } }),
    ...secretIds.map((secretId) =>
      db.agentSecret.create({ data: { agentId, secretId } }),
    ),
  ]);
};

export const getAgentAppConnections = async (
  projectId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const rows = await db.agentAppConnection.findMany({
    where: { agentId },
    select: { appConnectionId: true },
  });

  return rows.map((r) => r.appConnectionId);
};

export const updateAgentAppConnections = async (
  projectId: string,
  agentId: string,
  appConnectionIds: string[],
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  // Validate all app connections belong to this account
  const connections = await db.appConnection.findMany({
    where: { id: { in: appConnectionIds }, projectId },
    select: { id: true },
  });

  const validIds = new Set(connections.map((c) => c.id));
  const invalid = appConnectionIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      "One or more app connections not found",
    );
  }

  await db.$transaction([
    db.agentAppConnection.deleteMany({ where: { agentId } }),
    ...appConnectionIds.map((appConnectionId) =>
      db.agentAppConnection.create({ data: { agentId, appConnectionId } }),
    ),
  ]);
};
