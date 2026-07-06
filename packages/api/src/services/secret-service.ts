import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";
import {
  detectAnthropicAuthMode,
  detectOpenaiAuthMode,
  isHeaderInjection,
  isParamInjection,
  isPathInjection,
  isPathRegexInjection,
  isPathSafeValue,
  isPathTemplateInjection,
  parseGoogleServiceAccountJson,
  parseOpenaiAuthJson,
  parseOpenaiOAuthJson,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "../validations/secret";

const normalizeOpenaiValue = (
  raw: string,
): { value: string; hostPattern: string } => {
  let value = raw;
  const authJson = parseOpenaiAuthJson(value);
  if (authJson?.mode === "api-key" && authJson.apiKey) {
    value = authJson.apiKey;
  }
  const hostPattern =
    detectOpenaiAuthMode(value) === "oauth" ? "chatgpt.com" : "api.openai.com";
  return { value, hostPattern };
};

const validateGoogleServiceAccountValue = (raw: string): void => {
  if (!parseGoogleServiceAccountJson(raw)) {
    throw new ServiceError(
      "BAD_REQUEST",
      'Invalid service account JSON: must contain type "service_account", private_key, and client_email',
    );
  }
};

const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic API Key",
  openai: "OpenAI",
  generic: "Generic Secret",
  google_service_account: "Google Service Account",
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
  if (isPathTemplateInjection(config)) {
    return {
      pathTemplate: config.pathTemplate.trim(),
    } as Prisma.InputJsonValue;
  }
  if (isPathRegexInjection(config)) {
    return {
      pathRegex: config.pathRegex.trim(),
      pathReplacement: config.pathReplacement.trim(),
    } as Prisma.InputJsonValue;
  }
  return Prisma.JsonNull;
};

// A path-injected secret is substituted into the URL path verbatim, so an inline
// value containing a path-structural char would reshape the request. 1Password
// values are resolved at request time and guarded by the gateway, so only inline
// values are checked here; the gateway's `is_path_safe` is the authoritative guard.
const assertPathValueSafe = (
  config: CreateSecretInput["injectionConfig"],
  valueSource: string | undefined,
  value: string | undefined,
): void => {
  if (
    isPathInjection(config) &&
    valueSource !== "onepassword" &&
    value &&
    !isPathSafeValue(value.trim())
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Secret value can't contain / ? # % whitespace or control characters when injected into the URL path",
    );
  }
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
    const authMode = detectOpenaiAuthMode(value);
    const parsed = authMode === "oauth" ? parseOpenaiOAuthJson(value) : null;
    return {
      authMode,
      ...(parsed ? { accountId: parsed.tokens.account_id ?? null } : {}),
    } as Prisma.InputJsonValue;
  }
  if (type === "google_service_account") {
    const sa = parseGoogleServiceAccountJson(value);
    if (sa) {
      return {
        clientEmail: sa.client_email,
        ...(sa.project_id ? { projectId: sa.project_id } : {}),
      } as Prisma.InputJsonValue;
    }
  }
  return Prisma.JsonNull;
};

const buildOnePasswordMetadata = (
  type: string,
  opDisplay: CreateSecretInput["opDisplay"],
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  const meta: Record<string, unknown> = {};
  // LLM keys resolved from 1Password are always API-key mode (no value to inspect, no OAuth).
  if (type === "anthropic" || type === "openai") meta.authMode = "api-key";
  if (opDisplay) meta.opDisplay = opDisplay;
  return Object.keys(meta).length > 0
    ? (meta as Prisma.InputJsonValue)
    : Prisma.JsonNull;
};

export type { CreateSecretInput, UpdateSecretInput };

export const listSecrets = async (scope: ResourceScope) => {
  const secrets = await db.secret.findMany({
    where: scopeWhere(scope),
    select: {
      id: true,
      name: true,
      type: true,
      valueSource: true,
      opRef: true,
      hostPattern: true,
      pathPattern: true,
      injectionConfig: true,
      metadata: true,
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

  let hostPattern = input.hostPattern.trim();
  if (!hostPattern)
    throw new ServiceError("BAD_REQUEST", "Host pattern is required");

  if (input.type === "generic") {
    const config = input.injectionConfig;
    const hasHeader = isHeaderInjection(config) && config.headerName.trim();
    const hasParam = isParamInjection(config) && config.paramName.trim();
    const hasPath = isPathInjection(config);
    if (!hasHeader && !hasParam && !hasPath) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Header name, parameter name, or URL path template is required for generic secrets",
      );
    }
    assertPathValueSafe(config, input.valueSource, input.value);
  }

  const pathPattern = input.pathPattern?.trim() || null;
  const injectionConfig =
    input.type === "generic"
      ? buildInjectionConfig(input.injectionConfig)
      : Prisma.JsonNull;

  // Default to "inline" so existing callers and API clients that omit
  // valueSource keep storing the value in Postgres exactly as before.
  const valueSource = input.valueSource ?? "inline";

  // ── Value resolved from 1Password at request time (nothing stored in PG) ──
  if (valueSource === "onepassword") {
    // 1Password connections are per-project: the gateway resolves op:// refs via
    // the requesting agent's project connection. An org/partner-scoped secret
    // has no single project, so its value would silently fail to resolve —
    // reject it here instead of creating a secret that can never inject.
    if (!scope.projectId) {
      throw new ServiceError(
        "BAD_REQUEST",
        "1Password is only available for project-scoped secrets",
      );
    }
    if (!input.opRef) {
      throw new ServiceError("BAD_REQUEST", "Select a 1Password field");
    }
    // LLM keys from 1Password are treated as plain API keys on their fixed host.
    // Google SA secrets use the schema-defaulted hostPattern (which callers may override).
    if (input.type === "anthropic") hostPattern = "api.anthropic.com";
    if (input.type === "openai") hostPattern = "api.openai.com";

    return db.secret.create({
      data: {
        name,
        type: input.type,
        valueSource: "onepassword",
        encryptedValue: null,
        opRef: input.opRef,
        hostPattern,
        pathPattern,
        injectionConfig,
        metadata: buildOnePasswordMetadata(input.type, input.opDisplay),
        ...scopeCreate(scope),
      },
      select: {
        id: true,
        name: true,
        type: true,
        valueSource: true,
        opRef: true,
        hostPattern: true,
        pathPattern: true,
        createdAt: true,
      },
    });
  }

  // ── Inline value (encrypted at rest) ──
  let value = (input.value ?? "").trim();
  if (!value) throw new ServiceError("BAD_REQUEST", "Secret value is required");

  if (input.type === "openai") {
    const normalized = normalizeOpenaiValue(value);
    value = normalized.value;
    hostPattern = normalized.hostPattern;
  }

  if (input.type === "google_service_account") {
    validateGoogleServiceAccountValue(value);
  }

  const secret = await db.secret.create({
    data: {
      name,
      type: input.type,
      valueSource: "inline",
      encryptedValue: await getCrypto().encrypt(value),
      hostPattern,
      pathPattern,
      injectionConfig,
      metadata: buildMetadata(input.type, value),
      ...scopeCreate(scope),
    },
    select: {
      id: true,
      name: true,
      type: true,
      valueSource: true,
      opRef: true,
      hostPattern: true,
      pathPattern: true,
      createdAt: true,
    },
  });

  return { ...secret, preview: buildPreview(value) };
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
    select: { id: true, type: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "Name is required");
    data.name = name;
  }

  if (input.valueSource === "onepassword") {
    // Switch to / update a value resolved from 1Password. Per-project only, as in
    // createSecret: the gateway resolves op:// refs via the agent's project
    // connection, so org/partner scope has no connection to resolve through.
    if (!scope.projectId) {
      throw new ServiceError(
        "BAD_REQUEST",
        "1Password is only available for project-scoped secrets",
      );
    }
    if (!input.opRef)
      throw new ServiceError("BAD_REQUEST", "Select a 1Password field");
    data.valueSource = "onepassword";
    data.encryptedValue = null;
    data.opRef = input.opRef;
    if (secret.type === "anthropic") data.hostPattern = "api.anthropic.com";
    if (secret.type === "openai") data.hostPattern = "api.openai.com";
    // SA: preserve existing hostPattern — users may have set a custom host
    // (e.g. storage.googleapis.com). anthropic/openai have fixed hosts.
    data.metadata = buildOnePasswordMetadata(secret.type, input.opDisplay);
  } else if (input.value !== undefined) {
    let value = input.value.trim();
    if (!value)
      throw new ServiceError("BAD_REQUEST", "Secret value is required");

    if (secret.type === "openai") {
      const normalized = normalizeOpenaiValue(value);
      value = normalized.value;
      data.hostPattern = normalized.hostPattern;
    }

    if (secret.type === "google_service_account") {
      validateGoogleServiceAccountValue(value);
    }

    data.valueSource = "inline";
    data.encryptedValue = await getCrypto().encrypt(value);
    data.opRef = null;

    if (
      secret.type === "anthropic" ||
      secret.type === "openai" ||
      secret.type === "google_service_account"
    ) {
      data.metadata = buildMetadata(secret.type, value);
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
    assertPathValueSafe(input.injectionConfig, input.valueSource, input.value);
  }

  if (Object.keys(data).length === 0) {
    throw new ServiceError("BAD_REQUEST", "No fields to update");
  }

  await db.secret.update({ where: { id: secretId }, data });
};
