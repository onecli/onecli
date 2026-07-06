import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { getPolicyValidator } from "../providers/hooks/policy-validator";
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

  let inheritedSecretMode: SecretMode = "all";
  let parentSecretIds: string[] = [];
  let parentAppConnectionIds: string[] = [];

  if (parentIdentifier) {
    const parent = await db.agent.findFirst({
      where: { projectId, identifier: parentIdentifier },
      select: {
        secretMode: true,
        agentSecrets: { select: { secretId: true } },
        agentAppConnections: { select: { appConnectionId: true } },
      },
    });
    if (parent) {
      inheritedSecretMode = parent.secretMode as SecretMode;
      parentSecretIds = parent.agentSecrets.map((s) => s.secretId);
      parentAppConnectionIds = parent.agentAppConnections.map(
        (c) => c.appConnectionId,
      );
    }
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

    if (parentSecretIds.length > 0) {
      await db.agentSecret.createMany({
        data: parentSecretIds.map((secretId) => ({
          agentId: agent.id,
          secretId,
        })),
      });
    } else {
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
    }

    if (parentAppConnectionIds.length > 0) {
      await db.agentAppConnection.createMany({
        data: parentAppConnectionIds.map((appConnectionId) => ({
          agentId: agent.id,
          appConnectionId,
        })),
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

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });

  const secrets = await db.secret.findMany({
    where: {
      id: { in: secretIds },
      OR: [
        { projectId },
        ...(project?.organizationId
          ? [{ organizationId: project.organizationId, scope: "organization" }]
          : []),
      ],
    },
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

export type SessionPolicy = Record<string, unknown>;

export interface AgentAppConnectionEntry {
  appConnectionId: string;
  sessionPolicy: SessionPolicy | null;
}

export const getAgentAppConnections = async (
  projectId: string,
  agentId: string,
): Promise<AgentAppConnectionEntry[]> => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const rows = await db.agentAppConnection.findMany({
    where: { agentId },
    select: { appConnectionId: true, sessionPolicy: true },
  });

  return rows.map((r) => ({
    appConnectionId: r.appConnectionId,
    sessionPolicy: r.sessionPolicy as SessionPolicy | null,
  }));
};

export interface AgentGranularAccessEntry {
  agentId: string;
  agentName: string;
  connectionId: string;
  provider: string;
  connectionLabel: string | null;
  policy: SessionPolicy;
}

/**
 * Lists every agent→connection assignment in the project that carries a
 * non-empty granular policy (e.g. GitHub repository or Dropbox folder scoping).
 * Read-only overview for the Rules page; unrestricted assignments are skipped.
 */
export const listAgentGranularAccess = async (
  projectId: string,
): Promise<AgentGranularAccessEntry[]> => {
  const rows = await db.agentAppConnection.findMany({
    where: { agent: { projectId } },
    select: {
      sessionPolicy: true,
      agent: { select: { id: true, name: true } },
      appConnection: { select: { id: true, provider: true, label: true } },
    },
  });

  const entries: AgentGranularAccessEntry[] = [];
  for (const r of rows) {
    const policy = r.sessionPolicy as SessionPolicy | null;
    if (!policy || Object.keys(policy).length === 0) continue;
    entries.push({
      agentId: r.agent.id,
      agentName: r.agent.name,
      connectionId: r.appConnection.id,
      provider: r.appConnection.provider,
      connectionLabel: r.appConnection.label,
      policy,
    });
  }
  return entries;
};

export interface AgentAppConnectionInput {
  appConnectionId: string;
  sessionPolicy?: SessionPolicy | null;
}

export const updateAgentAppConnections = async (
  projectId: string,
  agentId: string,
  connections: AgentAppConnectionInput[],
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const appConnectionIds = connections.map((c) => c.appConnectionId);

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });

  const dbConnections = await db.appConnection.findMany({
    where: {
      id: { in: appConnectionIds },
      OR: [
        { projectId },
        ...(project?.organizationId
          ? [{ organizationId: project.organizationId, scope: "organization" }]
          : []),
      ],
    },
    select: { id: true, provider: true, metadata: true },
  });

  const validIds = new Set(dbConnections.map((c) => c.id));
  const invalid = appConnectionIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      "One or more app connections not found",
    );
  }

  const dbConnectionMap = new Map(dbConnections.map((c) => [c.id, c]));
  const validator = getPolicyValidator();
  for (const conn of connections) {
    if (!conn.sessionPolicy || Object.keys(conn.sessionPolicy).length === 0)
      continue;
    const dbConn = dbConnectionMap.get(conn.appConnectionId);
    if (dbConn) {
      await validator.validate(
        project?.organizationId ?? "",
        dbConn.provider,
        dbConn.metadata as Record<string, unknown> | null,
        conn.sessionPolicy,
      );
    }
  }

  await db.$transaction([
    db.agentAppConnection.deleteMany({ where: { agentId } }),
    ...connections.map((conn) =>
      db.agentAppConnection.create({
        data: {
          agentId,
          appConnectionId: conn.appConnectionId,
          sessionPolicy: conn.sessionPolicy
            ? (conn.sessionPolicy as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      }),
    ),
  ]);
};

export type ConnectionAccessLevel = "full" | "assigned" | "none";

export interface ConnectionAgentAccess {
  id: string;
  name: string;
  access: ConnectionAccessLevel;
  // True when an "assigned" agent's grant carries a granular session policy
  // (e.g. specific GitHub repos). Surfaced read-only so the connection-first UI
  // can flag it — the policy itself is managed on the agent side.
  scoped: boolean;
}

// Confirms a connection is visible to the project — a project-owned row, or an
// org-scoped row in the project's org (project members manage org rows via the
// project surface). Mirrors the OR-clause in updateAgentAppConnections.
const assertConnectionVisible = async (
  projectId: string,
  connectionId: string,
): Promise<void> => {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });

  const connection = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      OR: [
        { projectId },
        ...(project?.organizationId
          ? [{ organizationId: project.organizationId, scope: "organization" }]
          : []),
      ],
    },
    select: { id: true },
  });

  if (!connection) throw new ServiceError("NOT_FOUND", "Connection not found");
};

/**
 * Reverse view of agent↔connection access: every agent in the project and
 * whether it can use this connection. "all"-mode agents implicitly reach every
 * connection ("full"); "selective" agents reach only the connections they hold
 * a row for ("assigned"), otherwise "none".
 */
export const listConnectionAgents = async (
  projectId: string,
  connectionId: string,
): Promise<ConnectionAgentAccess[]> => {
  await assertConnectionVisible(projectId, connectionId);

  const agents = await db.agent.findMany({
    where: { projectId },
    select: { id: true, name: true, secretMode: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });

  const rows = await db.agentAppConnection.findMany({
    where: { appConnectionId: connectionId, agent: { projectId } },
    select: { agentId: true, sessionPolicy: true },
  });
  const scopedByAgent = new Map(
    rows.map((r) => {
      const policy = r.sessionPolicy as SessionPolicy | null;
      return [r.agentId, !!policy && Object.keys(policy).length > 0] as const;
    }),
  );

  return agents.map((a) => {
    const access: ConnectionAccessLevel =
      a.secretMode !== "selective"
        ? "full"
        : scopedByAgent.has(a.id)
          ? "assigned"
          : "none";
    return {
      id: a.id,
      name: a.name,
      access,
      scoped: access === "assigned" && (scopedByAgent.get(a.id) ?? false),
    };
  });
};

/**
 * Sets exactly which selective agents are granted this connection, keyed from
 * the connection side. Only ever adds/removes rows for the given selective
 * agents; unchanged rows (and their granular sessionPolicy) are left untouched.
 * "all"-mode agents already reach every connection and cannot be granted or
 * revoked here — passing one is rejected.
 */
export const setConnectionAgents = async (
  projectId: string,
  connectionId: string,
  agentIds: string[],
): Promise<{ added: number; removed: number }> => {
  await assertConnectionVisible(projectId, connectionId);

  const targetIds = [...new Set(agentIds)];

  if (targetIds.length > 0) {
    const targets = await db.agent.findMany({
      where: { id: { in: targetIds }, projectId },
      select: { id: true, secretMode: true },
    });
    const selective = new Set(
      targets.filter((a) => a.secretMode === "selective").map((a) => a.id),
    );
    const invalid = targetIds.filter((id) => !selective.has(id));
    if (invalid.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        "One or more agents are not selective agents in this project",
      );
    }
  }

  const target = new Set(targetIds);
  const currentRows = await db.agentAppConnection.findMany({
    where: {
      appConnectionId: connectionId,
      agent: { projectId, secretMode: "selective" },
    },
    select: { agentId: true },
  });
  const current = new Set(currentRows.map((r) => r.agentId));

  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { added: 0, removed: 0 };
  }

  await db.$transaction([
    db.agentAppConnection.deleteMany({
      where: { appConnectionId: connectionId, agentId: { in: toRemove } },
    }),
    // skipDuplicates makes a concurrent double-grant idempotent (composite PK)
    // instead of surfacing a P2002.
    db.agentAppConnection.createMany({
      data: toAdd.map((agentId) => ({
        agentId,
        appConnectionId: connectionId,
      })),
      skipDuplicates: true,
    }),
  ]);

  return { added: toAdd.length, removed: toRemove.length };
};
