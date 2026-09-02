import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers/crypto";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../../services/audit-service";
import { ServiceError } from "../../services/errors";
import { redisKeys } from "../clients/redis-keys";
import { withRedisLock } from "../clients/redis-lock";
import {
  createProvider,
  deleteProvider,
  isDuplicateProviderError,
  mergeProviderIntoClient,
  providerNameForOrg,
  removeProviderFromClient,
  updateProviderDetails,
  type SsoProviderInput,
} from "./cognito-idp-service";
import { extractSamlCertExpiry, looksLikeSamlMetadata } from "./saml-metadata";
import { safeFetch, type SsoUrlFetcher } from "./safe-fetch";

/**
 * SSO connection lifecycle. Every operation that touches Cognito runs under
 * ONE Redis lock acquisition (the whole create/enable/disable/delete/refresh
 * sequence) so partial states can't interleave; the cognito-idp-service
 * primitives are lock-free by contract.
 *
 * Disable is a FULL Cognito teardown (client-list removal + provider
 * deletion) with the row retained: the deploy-time reconciler is add-only
 * over pool contents, so a merely-unlisted provider would be silently
 * re-added on the next infra deploy. Enable recreates the provider from the
 * stored config + encrypted credentials.
 */

export type SsoConnectionStatus = "pending" | "active" | "disabled";

interface SsoConnectionConfig {
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  certExpiresAt?: string | null;
  /** Lifecycle status to restore on enable (set while disabled). */
  priorStatus?: SsoConnectionStatus;
}

export interface CreateSsoConnectionInput {
  type: "saml" | "oidc";
  displayName: string;
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface UpdateSsoConnectionInput {
  displayName?: string;
  enabled?: boolean;
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Injectable Cognito ops (default = real service) — test seam. */
export interface CognitoIdpOps {
  createProvider: typeof createProvider;
  updateProviderDetails: typeof updateProviderDetails;
  deleteProvider: typeof deleteProvider;
  mergeProviderIntoClient: typeof mergeProviderIntoClient;
  removeProviderFromClient: typeof removeProviderFromClient;
}

const defaultOps: CognitoIdpOps = {
  createProvider,
  updateProviderDetails,
  deleteProvider,
  mergeProviderIntoClient,
  removeProviderFromClient,
};

type LockRunner = typeof withRedisLock;

// Redacted shape — credentials NEVER leave this service.
const connectionSelect = {
  id: true,
  type: true,
  status: true,
  displayName: true,
  cognitoProviderName: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

const parseConfig = (value: Prisma.JsonValue | null): SsoConnectionConfig =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SsoConnectionConfig)
    : {};

const nonSecretConfig = (
  input: CreateSsoConnectionInput | (SsoConnectionConfig & { type?: string }),
  certExpiresAt: Date | null,
): SsoConnectionConfig => ({
  ...(input.metadataUrl ? { metadataUrl: input.metadataUrl } : {}),
  ...(input.metadataXml ? { metadataXml: input.metadataXml } : {}),
  ...(input.issuer ? { issuer: input.issuer } : {}),
  ...(input.clientId ? { clientId: input.clientId } : {}),
  certExpiresAt: certExpiresAt ? certExpiresAt.toISOString() : null,
});

const encryptSecret = async (clientSecret: string | undefined) =>
  clientSecret ? getCrypto().encrypt(JSON.stringify({ clientSecret })) : null;

const decryptSecret = async (
  credentials: string | null,
): Promise<string | undefined> => {
  if (!credentials) return undefined;
  try {
    const parsed = JSON.parse(await getCrypto().decrypt(credentials)) as {
      clientSecret?: string;
    };
    return parsed.clientSecret;
  } catch {
    return undefined; // degrade — refresh flows will require a new secret
  }
};

const toProviderInput = (
  type: "saml" | "oidc",
  config: SsoConnectionConfig,
  clientSecret: string | undefined,
): SsoProviderInput => ({
  type,
  metadataUrl: config.metadataUrl,
  metadataXml: config.metadataXml,
  issuer: config.issuer,
  clientId: config.clientId,
  clientSecret,
});

const certExpiryFor = (input: {
  type: string;
  metadataXml?: string;
}): Date | null =>
  input.type === "saml" && input.metadataXml
    ? extractSamlCertExpiry(input.metadataXml)
    : null;

export const listConnections = (organizationId: string) =>
  db.organizationSsoConnection.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: connectionSelect,
  });

export const createConnection = async (
  organizationId: string,
  input: CreateSsoConnectionInput,
  createdByUserId: string,
  ops: CognitoIdpOps = defaultOps,
  lock: LockRunner = withRedisLock,
) =>
  lock(redisKeys.cognitoClientLock(), async ({ isHeld }) => {
    const existing = await db.organizationSsoConnection.findFirst({
      where: { organizationId },
      select: { id: true },
    });
    if (existing) {
      throw new ServiceError(
        "CONFLICT",
        "This organization already has an SSO connection.",
      );
    }

    const name = providerNameForOrg(organizationId);
    let createdProvider = false;
    try {
      await ops.createProvider(name, { ...input });
      createdProvider = true;
    } catch (err) {
      if (!isDuplicateProviderError(err)) throw err;
      // A provider with our deterministic name exists but no row survived —
      // crash residue from a previous attempt. Adopt it (overwrite config)
      // ONLY if no row anywhere references the name; a referenced provider
      // must never be adopted or deleted.
      const holder = await db.organizationSsoConnection.findUnique({
        where: { cognitoProviderName: name },
        select: { id: true },
      });
      if (holder) {
        throw new ServiceError(
          "CONFLICT",
          "An SSO provider with this organization's identity already exists.",
        );
      }
      await ops.updateProviderDetails(name, { ...input });
    }

    try {
      await ops.mergeProviderIntoClient(name, isHeld);
    } catch (err) {
      if (createdProvider) {
        await ops.deleteProvider(name).catch(() => undefined);
      }
      throw err;
    }

    const config = nonSecretConfig(input, certExpiryFor(input));
    const credentials = await encryptSecret(input.clientSecret);
    try {
      return await db.organizationSsoConnection.create({
        data: {
          organizationId,
          type: input.type,
          status: "pending",
          cognitoProviderName: name,
          displayName: input.displayName,
          config: config as Prisma.InputJsonValue,
          credentials,
          createdByUserId,
        },
        select: connectionSelect,
      });
    } catch (err) {
      // Compensate only what THIS request created and nothing references.
      await ops.removeProviderFromClient(name, isHeld).catch(() => undefined);
      await ops.deleteProvider(name).catch(() => undefined);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ServiceError(
          "CONFLICT",
          "This organization already has an SSO connection.",
        );
      }
      throw err;
    }
  });

/**
 * Refuse to take down the org's SSO while `ssoRequired` is on — that would
 * lock out every non-exempt member (only break-glass logins would survive).
 */
const assertSsoNotRequired = async (
  organizationId: string,
  verb: "disabling" | "deleting",
): Promise<void> => {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { ssoRequired: true },
  });
  if (org?.ssoRequired) {
    throw new ServiceError(
      "CONFLICT",
      `This organization requires SSO. Turn off "Require single sign-on" before ${verb} the connection.`,
    );
  }
};

export const updateConnection = async (
  organizationId: string,
  connectionId: string,
  patch: UpdateSsoConnectionInput,
  ops: CognitoIdpOps = defaultOps,
  lock: LockRunner = withRedisLock,
) => {
  const row = await db.organizationSsoConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "SSO connection not found");

  // Lockout guard: disabling the connection while the org REQUIRES SSO would
  // block every non-exempt member's next login.
  if (patch.enabled === false && row.status !== "disabled") {
    await assertSsoNotRequired(organizationId, "disabling");
  }

  const type = row.type === "saml" ? ("saml" as const) : ("oidc" as const);
  const config = parseConfig(row.config);

  const wantsRefresh =
    patch.metadataUrl !== undefined ||
    patch.metadataXml !== undefined ||
    patch.issuer !== undefined ||
    patch.clientId !== undefined ||
    patch.clientSecret !== undefined;

  // Display-name-only changes don't touch Cognito — no lock.
  if (patch.enabled === undefined && !wantsRefresh) {
    if (patch.displayName === undefined) return redact(row);
    return db.organizationSsoConnection.update({
      where: { id: row.id },
      data: { displayName: patch.displayName },
      select: connectionSelect,
    });
  }

  return lock(redisKeys.cognitoClientLock(), async ({ isHeld }) => {
    const status = row.status as SsoConnectionStatus;
    let nextConfig: SsoConnectionConfig = { ...config };
    let nextStatus: SsoConnectionStatus = status;
    let nextCredentials: string | null | undefined; // undefined = unchanged

    if (wantsRefresh) {
      // Rebuild the FULL provider input: stored values overridden by the
      // patch; secret decrypted from the row when not rotating.
      const mergedInput: SsoProviderInput = {
        type,
        metadataUrl:
          patch.metadataUrl !== undefined
            ? patch.metadataUrl
            : patch.metadataXml !== undefined
              ? undefined // switching SAML source: exactly one key
              : config.metadataUrl,
        metadataXml:
          patch.metadataXml !== undefined
            ? patch.metadataXml
            : patch.metadataUrl !== undefined
              ? undefined
              : config.metadataXml,
        issuer: patch.issuer ?? config.issuer,
        clientId: patch.clientId ?? config.clientId,
        clientSecret:
          patch.clientSecret ?? (await decryptSecret(row.credentials)),
      };
      if (type === "oidc" && !mergedInput.clientSecret) {
        throw new ServiceError(
          "BAD_REQUEST",
          "The stored client secret is unreadable. Provide a new one.",
        );
      }
      // A disabled connection has no live Cognito provider — the refresh is
      // row-only and applies when it's re-enabled.
      if (status !== "disabled") {
        await ops.updateProviderDetails(row.cognitoProviderName, mergedInput);
      }
      nextConfig = {
        ...nonSecretConfig(mergedInput, certExpiryFor(mergedInput)),
        ...(config.priorStatus ? { priorStatus: config.priorStatus } : {}),
      };
      if (patch.clientSecret !== undefined) {
        nextCredentials = await encryptSecret(patch.clientSecret);
      }
    }

    if (patch.enabled === false && status !== "disabled") {
      await ops.removeProviderFromClient(row.cognitoProviderName, isHeld);
      await ops.deleteProvider(row.cognitoProviderName);
      nextConfig = { ...nextConfig, priorStatus: status };
      nextStatus = "disabled";
    } else if (patch.enabled === true && status === "disabled") {
      const clientSecret =
        patch.clientSecret ?? (await decryptSecret(row.credentials));
      const providerInput = toProviderInput(type, nextConfig, clientSecret);
      try {
        await ops.createProvider(row.cognitoProviderName, providerInput);
      } catch (err) {
        if (!isDuplicateProviderError(err)) throw err;
        await ops.updateProviderDetails(row.cognitoProviderName, providerInput);
      }
      await ops.mergeProviderIntoClient(row.cognitoProviderName, isHeld);
      // Restore the pre-disable lifecycle status; never mint "active".
      nextStatus = nextConfig.priorStatus ?? "pending";
      nextConfig = { ...nextConfig };
      delete nextConfig.priorStatus;
    }

    return db.organizationSsoConnection.update({
      where: { id: row.id },
      data: {
        ...(patch.displayName !== undefined
          ? { displayName: patch.displayName }
          : {}),
        status: nextStatus,
        config: nextConfig as Prisma.InputJsonValue,
        ...(nextCredentials !== undefined
          ? { credentials: nextCredentials }
          : {}),
      },
      select: connectionSelect,
    });
  });
};

export const deleteConnection = async (
  organizationId: string,
  connectionId: string,
  ops: CognitoIdpOps = defaultOps,
  lock: LockRunner = withRedisLock,
): Promise<void> => {
  const row = await db.organizationSsoConnection.findFirst({
    where: { id: connectionId, organizationId },
    select: { id: true, cognitoProviderName: true },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "SSO connection not found");

  // Lockout guard — same reasoning as the disable arm in updateConnection.
  await assertSsoNotRequired(organizationId, "deleting");

  await lock(redisKeys.cognitoClientLock(), async ({ isHeld }) => {
    // Client-list first, then the provider — Cognito can refuse to delete a
    // provider that a client still references.
    await ops.removeProviderFromClient(row.cognitoProviderName, isHeld);
    await ops.deleteProvider(row.cognitoProviderName);
    await db.organizationSsoConnection.delete({ where: { id: row.id } });
  });
};

/**
 * First successful SSO login promotes a pending connection to active —
 * completing the lifecycle the admin routes deliberately never mint.
 * Race-safe and idempotent: the conditional updateMany only ever flips
 * pending → active (never resurrects disabled), concurrent logins no-op,
 * and the audit fires exactly once (only when a row actually flipped).
 * No Cognito calls and no Redis lock — this touches no shared client state.
 */
export const markConnectionActive = async (
  connectionId: string,
  organizationId: string,
  actor: { id: string; email: string },
): Promise<void> => {
  const result = await db.organizationSsoConnection.updateMany({
    where: { id: connectionId, organizationId, status: "pending" },
    data: { status: "active" },
  });
  if (result.count === 0) return;
  await recordAuditEvent({
    organizationId,
    userId: actor.id,
    userEmail: actor.email,
    action: AUDIT_ACTIONS.UPDATE,
    service: AUDIT_SERVICES.SSO_CONNECTION,
    source: AUDIT_SOURCE.SSO_JIT,
    metadata: { connectionId, status: "active", trigger: "first-sso-login" },
  });
};

export interface SsoTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export const testConnection = async (
  organizationId: string,
  connectionId: string,
  fetcher: SsoUrlFetcher = safeFetch,
): Promise<{ ok: boolean; checks: SsoTestCheck[] }> => {
  const row = await db.organizationSsoConnection.findFirst({
    where: { id: connectionId, organizationId },
    select: connectionSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "SSO connection not found");

  const config = parseConfig(row.config);
  const checks: SsoTestCheck[] = [];

  if (row.type === "saml") {
    let xml = config.metadataXml;
    if (config.metadataUrl) {
      const res = await fetcher(config.metadataUrl);
      checks.push({
        name: "Metadata URL reachable",
        ok: res.ok,
        detail: res.ok ? `HTTP ${res.status}` : res.reason,
      });
      if (res.ok) xml = res.body;
    }
    if (xml) {
      const shapeOk = looksLikeSamlMetadata(xml);
      checks.push({
        name: "Metadata is SAML EntityDescriptor",
        ok: shapeOk,
      });
      const expiry = extractSamlCertExpiry(xml);
      if (expiry) {
        checks.push({
          name: "Signing certificate validity",
          ok: expiry.getTime() > Date.now(),
          detail: `expires ${expiry.toISOString().slice(0, 10)}`,
        });
      }
    } else if (checks.length === 0) {
      checks.push({
        name: "Metadata present",
        ok: false,
        detail: "No metadata URL or XML stored",
      });
    }
  } else {
    const issuer = (config.issuer ?? "").replace(/\/$/, "");
    const res = await fetcher(`${issuer}/.well-known/openid-configuration`);
    checks.push({
      name: "OIDC discovery reachable",
      ok: res.ok,
      detail: res.ok ? `HTTP ${res.status}` : res.reason,
    });
    if (res.ok) {
      let discoveredIssuer: string | undefined;
      try {
        discoveredIssuer = (
          JSON.parse(res.body) as { issuer?: string }
        ).issuer?.replace(/\/$/, "");
      } catch {
        // handled below
      }
      checks.push({
        name: "Issuer matches discovery document",
        ok: discoveredIssuer === issuer,
        detail: discoveredIssuer ? undefined : "Discovery document unreadable",
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
};

const redact = (row: {
  id: string;
  type: string;
  status: string;
  displayName: string;
  cognitoProviderName: string;
  config: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}) => ({
  id: row.id,
  type: row.type,
  status: row.status,
  displayName: row.displayName,
  cognitoProviderName: row.cognitoProviderName,
  config: row.config,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
