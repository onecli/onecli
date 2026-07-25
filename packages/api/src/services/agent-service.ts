import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { IDENTIFIER_REGEX } from "../validations/agent";

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

export const agentExistsByIdentifier = async (
  projectId: string,
  identifier: string,
): Promise<boolean> => {
  const existing = await db.agent.findFirst({
    where: { projectId, identifier: identifier.trim() },
    select: { id: true },
  });
  return existing !== null;
};

export const createAgent = async (
  projectId: string,
  name: string,
  identifier: string,
  parentIdentifier?: string,
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
      "Identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
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

  // A sub-agent inherits its parent's injection MODE only. The old per-agent
  // grant tables are frozen (step 10) — what a selective agent may inject now
  // comes from policy rules, so a selective parent's child starts with nothing
  // until a rule grants it (fail-closed) rather than silently inheriting the
  // parent's pool through rows the gateway no longer reads.
  let inheritedSecretMode: SecretMode = "all";

  if (parentIdentifier) {
    const parent = await db.agent.findFirst({
      where: { projectId, identifier: parentIdentifier },
      select: { secretMode: true },
    });
    if (parent) inheritedSecretMode = parent.secretMode as SecretMode;
  }

  const accessToken = generateAccessToken();

  try {
    const agent = await db.agent.create({
      data: {
        name: trimmed,
        identifier: trimmedIdentifier,
        accessToken,
        secretMode: inheritedSecretMode,
        projectId,
      },
      select: {
        id: true,
        name: true,
        identifier: true,
        createdAt: true,
      },
    });

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

export const setDefaultAgent = async (projectId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true, isDefault: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.isDefault)
    throw new ServiceError("BAD_REQUEST", "Agent is already the default");

  await db.$transaction([
    db.agent.updateMany({
      where: { projectId, isDefault: true },
      data: { isDefault: false },
    }),
    db.agent.update({ where: { id: agentId }, data: { isDefault: true } }),
  ]);
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
