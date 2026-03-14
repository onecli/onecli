"use server";

import { randomBytes } from "crypto";
import { db, Prisma } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import {
  deleteSecretMaterial,
  getConfiguredSecretProviderType,
  getSecretBackendStatus,
  parseSecretProviderType,
  persistSecretValue,
} from "@/lib/secrets/secret-backend";

const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic API Key",
  generic: "Generic Secret",
};

/**
 * Build a masked preview of a plaintext value.
 * Shows first 4 and last 4 characters: "sk-ant-a•••••xxxx"
 */
const buildPreview = (plaintext: string): string => {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"•".repeat(8)}${plaintext.slice(-4)}`;
};

const DEMO_SECRET_NAME = "Demo Secret (httpbin)";
const DEFAULT_AGENT_NAME = "Default Agent";

const ensureDefaultAgentForUser = async (userId: string) => {
  const existing = await db.agent.findFirst({
    where: { userId, isDefault: true },
    select: { id: true },
  });

  if (existing) return existing;

  return db.agent.create({
    data: {
      userId,
      name: DEFAULT_AGENT_NAME,
      isDefault: true,
      accessToken: `aoc_${randomBytes(32).toString("hex")}`,
    },
    select: { id: true },
  });
};

const ensureDemoSecret = async (userId: string) => {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { demoSeeded: true },
  });

  if (user.demoSeeded) return;

  const providerType = getConfiguredSecretProviderType();
  const defaultAgent = await ensureDefaultAgentForUser(userId);

  const secret = await db.secret.create({
    data: {
      name: DEMO_SECRET_NAME,
      type: "generic",
      providerType,
      providerRef: null,
      encryptedValue: null,
      hostPattern: "httpbin.org",
      pathPattern: "/anything/*",
      injectionConfig: {
        headerName: "Authorization",
        valueFormat: "Bearer {value}",
      },
      userId,
    },
    select: { id: true },
  });

  try {
    const material = await persistSecretValue({
      providerType,
      userId,
      secretId: secret.id,
      value: "WELCOME-TO-ONECLI-SECRETS-ARE-WORKING",
    });

    await db.$transaction([
      db.secret.update({
        where: { id: secret.id },
        data: {
          providerType: material.providerType,
          providerRef: material.providerRef,
          encryptedValue: material.encryptedValue,
        },
      }),
      db.agentSecretBinding.create({
        data: {
          agentId: defaultAgent.id,
          secretId: secret.id,
        },
      }),
      db.user.update({
        where: { id: userId },
        data: { demoSeeded: true },
      }),
    ]);
  } catch (error) {
    await db.secret.delete({ where: { id: secret.id } }).catch(() => undefined);
    throw error;
  }
};

const resolveUserId = async (authId?: string) => {
  let id = authId;
  if (!id) {
    const session = await getServerSession();
    if (!session) throw new Error("Not authenticated");
    id = session.id;
  }

  const user = await db.user.findUnique({
    where: { externalAuthId: id },
    select: { id: true },
  });

  if (!user) throw new Error("User not found");
  return user.id;
};

export async function getSecrets(authId?: string) {
  const userId = await resolveUserId(authId);
  await ensureDemoSecret(userId);

  const secrets = await db.secret.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      type: true,
      hostPattern: true,
      pathPattern: true,
      injectionConfig: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return secrets.map((s) => ({
    ...s,
    typeLabel: SECRET_TYPE_LABELS[s.type] ?? s.type,
  }));
}

export async function getSecretsMode(authId?: string) {
  // Enforce auth and user ownership semantics like other secret actions.
  await resolveUserId(authId);
  return getSecretBackendStatus();
}

interface CreateSecretInput {
  name: string;
  type: "anthropic" | "generic";
  value: string;
  hostPattern: string;
  pathPattern?: string;
  injectionConfig?: { headerName: string; valueFormat: string } | null;
}

export async function createSecret(input: CreateSecretInput, authId?: string) {
  const userId = await resolveUserId(authId);

  const name = input.name.trim();
  if (!name || name.length > 255) {
    throw new Error("Name must be between 1 and 255 characters");
  }

  const value = input.value.trim();
  if (!value) throw new Error("Secret value is required");

  const hostPattern = input.hostPattern.trim();
  if (!hostPattern) throw new Error("Host pattern is required");

  if (input.type === "generic") {
    if (!input.injectionConfig?.headerName?.trim()) {
      throw new Error("Header name is required for generic secrets");
    }
  }

  const preview = buildPreview(value);
  const pathPattern = input.pathPattern?.trim() || null;
  const injectionConfig =
    input.type === "generic" && input.injectionConfig
      ? ({
          headerName: input.injectionConfig.headerName.trim(),
          valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
        } as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const providerType = getConfiguredSecretProviderType();
  const defaultAgent = await ensureDefaultAgentForUser(userId);

  const createdSecret = await db.secret.create({
    data: {
      name,
      type: input.type,
      providerType,
      providerRef: null,
      encryptedValue: null,
      hostPattern,
      pathPattern,
      injectionConfig,
      userId,
    },
    select: { id: true },
  });

  let material;
  try {
    material = await persistSecretValue({
      providerType,
      userId,
      secretId: createdSecret.id,
      value,
    });
  } catch (error) {
    await db.secret
      .delete({ where: { id: createdSecret.id } })
      .catch(() => undefined);
    throw error;
  }

  const secret = await db.secret.update({
    where: { id: createdSecret.id },
    data: {
      providerType: material.providerType,
      providerRef: material.providerRef,
      encryptedValue: material.encryptedValue,
    },
    select: {
      id: true,
      name: true,
      type: true,
      hostPattern: true,
      pathPattern: true,
      createdAt: true,
    },
  });

  await db.agentSecretBinding.create({
    data: {
      agentId: defaultAgent.id,
      secretId: secret.id,
    },
  });

  return { ...secret, preview };
}

export async function deleteSecret(secretId: string, authId?: string) {
  const userId = await resolveUserId(authId);

  const secret = await db.secret.findFirst({
    where: { id: secretId, userId },
    select: {
      id: true,
      userId: true,
      providerType: true,
      providerRef: true,
      encryptedValue: true,
    },
  });

  if (!secret) throw new Error("Secret not found");

  await deleteSecretMaterial({
    id: secret.id,
    userId: secret.userId,
    providerType: parseSecretProviderType(secret.providerType),
    providerRef: secret.providerRef,
    encryptedValue: secret.encryptedValue,
  });

  await db.secret.delete({ where: { id: secretId } });
}

interface UpdateSecretInput {
  value?: string;
  hostPattern?: string;
  pathPattern?: string | null;
  injectionConfig?: { headerName: string; valueFormat: string } | null;
}

export async function getDemoInfo(authId?: string) {
  const userId = await resolveUserId(authId);
  await ensureDemoSecret(userId);

  const demoSecret = await db.secret.findFirst({
    where: { userId, name: DEMO_SECRET_NAME },
    select: { id: true },
  });
  if (!demoSecret) return null;

  const agent = await db.agent.findFirst({
    where: { userId, isDefault: true },
    select: { accessToken: true },
  });

  return { agentToken: agent?.accessToken ?? null };
}

export async function updateSecret(
  secretId: string,
  input: UpdateSecretInput,
  authId?: string,
) {
  const userId = await resolveUserId(authId);

  const secret = await db.secret.findFirst({
    where: { id: secretId, userId },
    select: {
      id: true,
      userId: true,
      type: true,
      providerType: true,
      providerRef: true,
    },
  });

  if (!secret) throw new Error("Secret not found");

  const data: Record<string, unknown> = {};

  if (input.value !== undefined) {
    const value = input.value.trim();
    if (!value) throw new Error("Secret value is required");
    const material = await persistSecretValue({
      providerType: parseSecretProviderType(secret.providerType),
      userId: secret.userId,
      secretId: secret.id,
      value,
      providerRef: secret.providerRef,
    });
    data.providerType = material.providerType;
    data.providerRef = material.providerRef;
    data.encryptedValue = material.encryptedValue;
  }

  if (input.hostPattern !== undefined) {
    const hostPattern = input.hostPattern.trim();
    if (!hostPattern) throw new Error("Host pattern is required");
    data.hostPattern = hostPattern;
  }

  if (input.pathPattern !== undefined) {
    data.pathPattern = input.pathPattern?.trim() || null;
  }

  if (input.injectionConfig !== undefined && secret.type === "generic") {
    data.injectionConfig = input.injectionConfig
      ? ({
          headerName: input.injectionConfig.headerName.trim(),
          valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
        } as Prisma.InputJsonValue)
      : Prisma.JsonNull;
  }

  if (Object.keys(data).length === 0) {
    throw new Error("No fields to update");
  }

  await db.secret.update({
    where: { id: secretId },
    data,
  });
}
