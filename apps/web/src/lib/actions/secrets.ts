"use server";

import { db, Prisma } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { cryptoService } from "@/lib/crypto";

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

export async function getSecrets(authId?: string) {
  const userId = await resolveUserId(authId);

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
      _count: { select: { policies: true } },
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

export async function deleteSecret(secretId: string, authId?: string) {
  const userId = await resolveUserId(authId);

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

export async function updateSecret(
  secretId: string,
  input: UpdateSecretInput,
  authId?: string,
) {
  const userId = await resolveUserId(authId);

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
