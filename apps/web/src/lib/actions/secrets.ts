"use server";

import { db, Prisma } from "@onecli/db";
import { resolveUserId } from "@/lib/actions/resolve-user";
import { cryptoService } from "@/lib/crypto";
import { DEMO_SECRET_NAME } from "@/lib/constants";

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

export async function getSecrets() {
  const userId = await resolveUserId();

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

interface CreateSecretInput {
  name: string;
  type: "anthropic" | "generic";
  value: string;
  hostPattern: string;
  pathPattern?: string;
  injectionConfig?: { headerName: string; valueFormat: string } | null;
}

export async function createSecret(input: CreateSecretInput) {
  const userId = await resolveUserId();

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

  const encryptedValue = cryptoService.encrypt(value);
  const preview = buildPreview(value);
  const pathPattern = input.pathPattern?.trim() || null;
  const injectionConfig =
    input.type === "generic" && input.injectionConfig
      ? ({
          headerName: input.injectionConfig.headerName.trim(),
          valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
        } as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const secret = await db.secret.create({
    data: {
      name,
      type: input.type,
      encryptedValue,
      hostPattern,
      pathPattern,
      injectionConfig,
      userId,
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

  return { ...secret, preview };
}

export async function deleteSecret(secretId: string) {
  const userId = await resolveUserId();

  const secret = await db.secret.findFirst({
    where: { id: secretId, userId },
    select: { id: true },
  });

  if (!secret) throw new Error("Secret not found");

  await db.secret.delete({ where: { id: secretId } });
}

interface UpdateSecretInput {
  value?: string;
  hostPattern?: string;
  pathPattern?: string | null;
  injectionConfig?: { headerName: string; valueFormat: string } | null;
}

export async function getDemoInfo() {
  const userId = await resolveUserId();

  const [demoSecret, agent] = await Promise.all([
    db.secret.findFirst({
      where: { userId, name: DEMO_SECRET_NAME },
      select: { id: true },
    }),
    db.agent.findFirst({
      where: { userId, isDefault: true },
      select: { accessToken: true },
    }),
  ]);

  if (!demoSecret || !agent) return null;

  return { agentToken: agent.accessToken };
}

export async function updateSecret(secretId: string, input: UpdateSecretInput) {
  const userId = await resolveUserId();

  const secret = await db.secret.findFirst({
    where: { id: secretId, userId },
    select: { id: true, type: true },
  });

  if (!secret) throw new Error("Secret not found");

  const data: Record<string, unknown> = {};

  if (input.value !== undefined) {
    const value = input.value.trim();
    if (!value) throw new Error("Secret value is required");
    data.encryptedValue = cryptoService.encrypt(value);
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
