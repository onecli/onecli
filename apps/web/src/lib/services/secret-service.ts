import { db, Prisma } from "@onecli/db";
import { cryptoService } from "@/lib/crypto";
import { ServiceError } from "@/lib/services/errors";
import {
  detectAnthropicAuthMode,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "@/lib/validations/secret";

const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic API Key",
  generic: "Generic Secret",
  google_oauth: "Google OAuth",
};

/**
 * Build a masked preview of a plaintext value.
 * Shows first 4 and last 4 characters: "sk-ant-a--------xxxx"
 */
const buildPreview = (plaintext: string): string => {
  if (plaintext.length <= 8) return "\u2022".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"\u2022".repeat(8)}${plaintext.slice(-4)}`;
};

export const listSecrets = async (accountId: string) => {
  const secrets = await db.secret.findMany({
    where: { accountId },
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
};

export type { CreateSecretInput, UpdateSecretInput };

export const createSecret = async (
  accountId: string,
  input: CreateSecretInput,
) => {
  const name = input.name.trim();
  if (!name || name.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  const value = input.value.trim();
  if (!value) throw new ServiceError("BAD_REQUEST", "Secret value is required");

  const hostPattern = input.hostPattern.trim();
  if (!hostPattern)
    throw new ServiceError("BAD_REQUEST", "Host pattern is required");

  if (input.type === "generic") {
    if (!input.injectionConfig?.headerName?.trim()) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Header name is required for generic secrets",
      );
    }
  }

  if (input.type === "google_oauth") {
    // Composite value: wrap refresh token + optional client credentials into JSON
    // so the gateway can extract each field for form-body injection.
    const composite: Record<string, string> = { refresh_token: value };
    const config = input.injectionConfig as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (config?.clientId?.trim()) composite.client_id = config.clientId.trim();
    if (config?.clientSecret?.trim())
      composite.client_secret = config.clientSecret.trim();
    // Re-assign for encryption below
    const compositeValue = JSON.stringify(composite);
    const encryptedValue = await cryptoService.encrypt(compositeValue);
    const preview = buildPreview(value); // Preview shows the refresh token, not the JSON

    const secret = await db.secret.create({
      data: {
        name,
        type: input.type,
        encryptedValue,
        hostPattern: hostPattern || "oauth2.googleapis.com",
        pathPattern: input.pathPattern?.trim() || "/token",
        injectionConfig: Prisma.JsonNull,
        metadata: Prisma.JsonNull,
        accountId,
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

  const encryptedValue = await cryptoService.encrypt(value);
  const preview = buildPreview(value);
  const pathPattern = input.pathPattern?.trim() || null;
  const injectionConfig =
    input.type === "generic" && input.injectionConfig
      ? ({
          headerName: input.injectionConfig.headerName!.trim(),
          valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
        } as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const metadata =
    input.type === "anthropic"
      ? ({ authMode: detectAnthropicAuthMode(value) } as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const secret = await db.secret.create({
    data: {
      name,
      type: input.type,
      encryptedValue,
      hostPattern,
      pathPattern,
      injectionConfig,
      metadata,
      accountId,
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
};

export const deleteSecret = async (accountId: string, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, accountId },
    select: { id: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  await db.secret.delete({ where: { id: secretId } });
};

export const updateSecret = async (
  accountId: string,
  secretId: string,
  input: UpdateSecretInput,
) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, accountId },
    select: { id: true, type: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  const data: Record<string, unknown> = {};

  if (input.value !== undefined) {
    const value = input.value.trim();
    if (!value)
      throw new ServiceError("BAD_REQUEST", "Secret value is required");

    if (secret.type === "google_oauth") {
      // Re-wrap refresh token + optional client credentials into composite JSON
      const composite: Record<string, string> = { refresh_token: value };
      const config = input.injectionConfig as {
        clientId?: string;
        clientSecret?: string;
      } | null;
      if (config?.clientId?.trim())
        composite.client_id = config.clientId.trim();
      if (config?.clientSecret?.trim())
        composite.client_secret = config.clientSecret.trim();
      data.encryptedValue = await cryptoService.encrypt(
        JSON.stringify(composite),
      );
    } else {
      data.encryptedValue = await cryptoService.encrypt(value);
    }

    // Re-detect auth mode when value changes for Anthropic secrets
    if (secret.type === "anthropic") {
      data.metadata = {
        authMode: detectAnthropicAuthMode(value),
      } as Prisma.InputJsonValue;
    }
  }

  if (input.hostPattern !== undefined) {
    const hostPattern = input.hostPattern.trim();
    if (!hostPattern)
      throw new ServiceError("BAD_REQUEST", "Host pattern is required");
    data.hostPattern = hostPattern;
  }

  if (input.pathPattern !== undefined) {
    data.pathPattern = input.pathPattern?.trim() || null;
  }

  if (input.injectionConfig !== undefined && secret.type === "generic") {
    data.injectionConfig = input.injectionConfig
      ? ({
          headerName: input.injectionConfig.headerName!.trim(),
          valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
        } as Prisma.InputJsonValue)
      : Prisma.JsonNull;
  }

  if (Object.keys(data).length === 0) {
    throw new ServiceError("BAD_REQUEST", "No fields to update");
  }

  await db.secret.update({
    where: { id: secretId },
    data,
  });
};
