import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";
import {
  detectAnthropicAuthMode,
  isHeaderInjection,
  isParamInjection,
  parseCodexAuthJson,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "../validations/secret";

const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic API Key",
  openai: "OpenAI API Key",
  codex: "OpenAI Codex (OAuth)",
  generic: "Generic Secret",
};

const buildPreview = (plaintext: string): string => {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"•".repeat(8)}${plaintext.slice(-4)}`;
};

const buildInjectionConfig = (
  config: CreateSecretInput["injectionConfig"],
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (!config) return Prisma.JsonNull;
  if (isParamInjection(config)) {
    return {
      paramName: config.paramName.trim(),
      paramFormat: config.paramFormat?.trim() || "{value}",
    } as Prisma.InputJsonValue;
  }
  if (isHeaderInjection(config)) {
    return {
      headerName: config.headerName.trim(),
      valueFormat: config.valueFormat?.trim() || "{value}",
    } as Prisma.InputJsonValue;
  }
  return Prisma.JsonNull;
};

const buildMetadata = (
  type: string,
  value: string,
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (type === "anthropic") {
    return {
      authMode: detectAnthropicAuthMode(value) ?? "api-key",
    } as Prisma.InputJsonValue;
  }
  if (type === "openai") {
    return { authMode: "api-key" } as Prisma.InputJsonValue;
  }
  if (type === "codex") {
    const parsed = parseCodexAuthJson(value);
    return {
      authMode: "oauth",
      accountId: parsed?.tokens?.account_id ?? null,
    } as Prisma.InputJsonValue;
  }
  return Prisma.JsonNull;
};

export type { CreateSecretInput, UpdateSecretInput };

export const listSecrets = async (scope: ResourceScope) => {
  const secrets = await db.secret.findMany({
    where: scopeWhere(scope),
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

export const createSecret = async (
  scope: ResourceScope,
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

  if (input.type === "codex") {
    if (!parseCodexAuthJson(value)) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Codex value must be valid auth.json with tokens.access_token and tokens.refresh_token",
      );
    }
  }

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

  const secret = await db.secret.create({
    data: {
      name,
      type: input.type,
      encryptedValue,
      hostPattern,
      pathPattern,
      injectionConfig:
        input.type === "generic"
          ? buildInjectionConfig(input.injectionConfig)
          : Prisma.JsonNull,
      metadata: buildMetadata(input.type, value),
      ...scopeCreate(scope),
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

export const deleteSecret = async (scope: ResourceScope, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: scopeOwnership(scope, secretId),
    select: { id: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  await db.secret.delete({ where: { id: secretId } });
};

export const updateSecret = async (
  scope: ResourceScope,
  secretId: string,
  input: UpdateSecretInput,
) => {
  const secret = await db.secret.findFirst({
    where: scopeOwnership(scope, secretId),
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

    if (secret.type === "anthropic") {
      data.metadata = {
        authMode: detectAnthropicAuthMode(value) ?? "api-key",
      } as Prisma.InputJsonValue;
    } else if (secret.type === "openai") {
      data.metadata = { authMode: "api-key" } as Prisma.InputJsonValue;
    } else if (secret.type === "codex") {
      const parsed = parseCodexAuthJson(value);
      data.metadata = {
        authMode: "oauth",
        accountId: parsed?.tokens?.account_id ?? null,
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
    data.injectionConfig = buildInjectionConfig(input.injectionConfig);
  }

  if (Object.keys(data).length === 0) {
    throw new ServiceError("BAD_REQUEST", "No fields to update");
  }

  await db.secret.update({ where: { id: secretId }, data });
};
