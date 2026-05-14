import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import {
  detectAnthropicAuthMode,
  isHeaderInjection,
  isParamInjection,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "../validations/secret";

const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic API Key",
  openai: "OpenAI API Key",
  generic: "Generic Secret",
};

/**
 * Build a masked preview of a plaintext value.
 * Shows first 4 and last 4 characters: "sk-ant-a--------xxxx"
 */
const buildPreview = (plaintext: string): string => {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"•".repeat(8)}${plaintext.slice(-4)}`;
};

export const listSecrets = async (projectId: string) => {
  const secrets = await db.secret.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      type: true,
      hostPattern: true,
      pathPattern: true,
      injectionConfig: true,
      isPlatform: true,
      scope: true,
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
  projectId: string,
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
    const config = input.injectionConfig;
    const hasHeader = isHeaderInjection(config) && config.headerName.trim();
    const hasParam = isParamInjection(config) && config.paramName.trim();
    if (!hasHeader && !hasParam) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Header name or parameter name is required for generic secrets",
      );
    }
  }

  const encryptedValue = await getCrypto().encrypt(value);
  const preview = buildPreview(value);
  const pathPattern = input.pathPattern?.trim() || null;
  let injectionConfig: Prisma.InputJsonValue | typeof Prisma.JsonNull =
    Prisma.JsonNull;
  if (input.type === "generic" && input.injectionConfig) {
    if (isParamInjection(input.injectionConfig)) {
      injectionConfig = {
        paramName: input.injectionConfig.paramName.trim(),
        paramFormat: input.injectionConfig.paramFormat?.trim() || "{value}",
      } as Prisma.InputJsonValue;
    } else if (isHeaderInjection(input.injectionConfig)) {
      injectionConfig = {
        headerName: input.injectionConfig.headerName.trim(),
        valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
      } as Prisma.InputJsonValue;
    }
  }

  const metadata =
    input.type === "anthropic"
      ? ({
          authMode: detectAnthropicAuthMode(value) ?? "api-key",
        } as Prisma.InputJsonValue)
      : input.type === "openai"
        ? ({ authMode: "api-key" } as Prisma.InputJsonValue)
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
      scope: "project",
      projectId,
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

export const deleteSecret = async (projectId: string, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, projectId },
    select: { id: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  await db.secret.delete({ where: { id: secretId } });
};

export const updateSecret = async (
  projectId: string,
  secretId: string,
  input: UpdateSecretInput,
) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, projectId },
    select: { id: true, type: true, isPlatform: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  if (secret.isPlatform) {
    const hasNonValueFields =
      input.name !== undefined ||
      input.hostPattern !== undefined ||
      input.pathPattern !== undefined ||
      input.injectionConfig !== undefined;
    if (hasNonValueFields)
      throw new ServiceError(
        "FORBIDDEN",
        "Only the value can be updated on platform secrets",
      );
    if (input.value === undefined)
      throw new ServiceError("BAD_REQUEST", "Value is required");
  }

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "Name is required");
    data.name = name;
  }

  if (input.value !== undefined) {
    const value = input.value.trim();
    if (!value)
      throw new ServiceError("BAD_REQUEST", "Secret value is required");
    data.encryptedValue = await getCrypto().encrypt(value);

    if (secret.isPlatform) {
      data.isPlatform = false;
    }

    // Re-detect auth mode when value changes for Anthropic secrets
    if (secret.type === "anthropic") {
      data.metadata = {
        authMode: detectAnthropicAuthMode(value) ?? "api-key",
      } as Prisma.InputJsonValue;
    } else if (secret.type === "openai") {
      data.metadata = { authMode: "api-key" } as Prisma.InputJsonValue;
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
    if (!input.injectionConfig) {
      data.injectionConfig = Prisma.JsonNull;
    } else if (isParamInjection(input.injectionConfig)) {
      data.injectionConfig = {
        paramName: input.injectionConfig.paramName.trim(),
        paramFormat: input.injectionConfig.paramFormat?.trim() || "{value}",
      } as Prisma.InputJsonValue;
    } else if (isHeaderInjection(input.injectionConfig)) {
      data.injectionConfig = {
        headerName: input.injectionConfig.headerName.trim(),
        valueFormat: input.injectionConfig.valueFormat?.trim() || "{value}",
      } as Prisma.InputJsonValue;
    } else {
      data.injectionConfig = Prisma.JsonNull;
    }
  }

  if (Object.keys(data).length === 0) {
    throw new ServiceError("BAD_REQUEST", "No fields to update");
  }

  await db.secret.update({
    where: { id: secretId },
    data,
  });
};
