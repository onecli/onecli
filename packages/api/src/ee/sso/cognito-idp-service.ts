import { createHash } from "node:crypto";
import {
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  ListIdentityProvidersCommand,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
  type CognitoIdentityProviderClient,
  type UpdateUserPoolClientCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import { cognitoClient } from "../clients/cognito-client";
import { SAML_EMAIL_CLAIM, SAML_NAME_CLAIM } from "./saml-claims";
import { COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID } from "../../lib/env";
import { ServiceError } from "../../services/errors";

/**
 * Lock-free Cognito primitives for SSO identity providers. Callers
 * (sso-connection-service) hold the Redis client lock across whole
 * operations; nothing here acquires it — see redis-lock.ts reentrancy note.
 */

export interface SsoProviderInput {
  type: "saml" | "oidc";
  metadataUrl?: string;
  metadataXml?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

const requireIds = (): { userPoolId: string; clientId: string } => {
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
    throw new Error(
      "COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID env vars are required for SSO management",
    );
  }
  return { userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID };
};

/**
 * Deterministic, immutable, PII-free provider name (Cognito caps names at
 * 32 chars). The DB row's cognitoProviderName is the source of truth
 * everywhere else — later steps read it, never recompute.
 */
export const providerNameForOrg = (orgId: string): string =>
  `org-${createHash("sha256").update(orgId).digest("hex").slice(0, 24)}`;

/**
 * ProviderDetails are ALWAYS rebuilt from scratch — UpdateIdentityProvider
 * replaces the whole map, and merging a describe would e.g. send both
 * MetadataURL and MetadataFile after a SAML source switch.
 */
export const buildProviderDetails = (
  input: SsoProviderInput,
): Record<string, string> => {
  if (input.type === "saml") {
    if (input.metadataUrl) return { MetadataURL: input.metadataUrl };
    if (input.metadataXml) return { MetadataFile: input.metadataXml };
    throw new ServiceError(
      "BAD_REQUEST",
      "SAML connections need a metadata URL or metadata XML",
    );
  }
  if (!input.issuer || !input.clientId || !input.clientSecret) {
    throw new ServiceError(
      "BAD_REQUEST",
      "OIDC connections need an issuer, client ID, and client secret",
    );
  }
  return {
    oidc_issuer: input.issuer,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    attributes_request_method: "GET",
    authorize_scopes: "openid email profile",
  };
};

const attributeMappingFor = (
  type: SsoProviderInput["type"],
): Record<string, string> =>
  type === "oidc"
    ? { email: "email", name: "name" }
    : { email: SAML_EMAIL_CLAIM, name: SAML_NAME_CLAIM };

const errorName = (err: unknown): string =>
  err instanceof Error ? err.name : "";

export const isDuplicateProviderError = (err: unknown): boolean =>
  errorName(err) === "DuplicateProviderException";

const mapProviderError = (err: unknown): unknown => {
  if (errorName(err) === "LimitExceededException") {
    return new ServiceError(
      "BAD_REQUEST",
      "The login client has reached its identity-provider limit. Contact support to raise it.",
    );
  }
  return err;
};

export const createProvider = async (
  name: string,
  input: SsoProviderInput,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<void> => {
  const { userPoolId } = requireIds();
  try {
    await client.send(
      new CreateIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName: name,
        ProviderType: input.type === "saml" ? "SAML" : "OIDC",
        ProviderDetails: buildProviderDetails(input),
        AttributeMapping: attributeMappingFor(input.type),
      }),
    );
  } catch (err) {
    throw mapProviderError(err);
  }
};

export const updateProviderDetails = async (
  name: string,
  input: SsoProviderInput,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<void> => {
  const { userPoolId } = requireIds();
  await client.send(
    new UpdateIdentityProviderCommand({
      UserPoolId: userPoolId,
      ProviderName: name,
      ProviderDetails: buildProviderDetails(input),
      AttributeMapping: attributeMappingFor(input.type),
    }),
  );
};

export const deleteProvider = async (
  name: string,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<void> => {
  const { userPoolId } = requireIds();
  try {
    await client.send(
      new DeleteIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName: name,
      }),
    );
  } catch (err) {
    if (errorName(err) === "ResourceNotFoundException") return; // idempotent
    throw err;
  }
};

const listPoolProviderNames = async (
  userPoolId: string,
  client: CognitoIdentityProviderClient,
): Promise<string[]> => {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new ListIdentityProvidersCommand({
        UserPoolId: userPoolId,
        MaxResults: 60,
        NextToken: nextToken,
      }),
    );
    for (const provider of page.Providers ?? []) {
      if (provider.ProviderName) names.push(provider.ProviderName);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return names;
};

/**
 * Read-modify-write of the app client's SupportedIdentityProviders. The
 * caller MUST hold the Redis lock; `isHeld` is re-checked right before each
 * write (shrinks the TTL-expiry TOCTOU — Cognito has no fencing token).
 * Fresh describe per attempt: a stale payload retried after
 * ConcurrentModificationException would clobber the concurrent writer.
 * The desired list is pruned to providers that actually exist — a dangling
 * name would poison every future client write (matches the deploy-time
 * reconciler's semantics).
 */
const updateClientProviders = async (
  mutate: (current: Set<string>) => void,
  isHeld: () => Promise<boolean>,
  client: CognitoIdentityProviderClient,
): Promise<void> => {
  const { userPoolId, clientId } = requireIds();
  let attempt = 0;
  for (;;) {
    const described = await client.send(
      new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
      }),
    );
    const config = described.UserPoolClient;
    if (!config) {
      throw new Error(`DescribeUserPoolClient returned no client`);
    }

    const poolNames = await listPoolProviderNames(userPoolId, client);
    const live = new Set(["COGNITO", ...poolNames]);
    const desired = new Set(config.SupportedIdentityProviders ?? []);
    mutate(desired);
    const merged = [...desired].filter((name) => live.has(name)).sort();

    const current = [...(config.SupportedIdentityProviders ?? [])].sort();
    if (
      merged.length === current.length &&
      merged.every((name, i) => name === current[i])
    ) {
      return; // already in the desired state
    }

    const updatable = { ...config };
    delete updatable.ClientSecret;
    delete updatable.LastModifiedDate;
    delete updatable.CreationDate;
    const input: UpdateUserPoolClientCommandInput = {
      ...updatable,
      UserPoolId: userPoolId,
      ClientId: clientId,
      SupportedIdentityProviders: merged,
    };

    if (!(await isHeld())) {
      throw new ServiceError(
        "CONFLICT",
        "The SSO configuration lock expired. Try again.",
      );
    }
    try {
      await client.send(new UpdateUserPoolClientCommand(input));
      return;
    } catch (err) {
      attempt += 1;
      const name = errorName(err);
      const retryable =
        name === "ConcurrentModificationException" ||
        name === "TooManyRequestsException";
      if (!retryable || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      // loop: rebuild from a fresh describe
    }
  }
};

export const mergeProviderIntoClient = (
  name: string,
  isHeld: () => Promise<boolean>,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<void> =>
  updateClientProviders((desired) => void desired.add(name), isHeld, client);

export const removeProviderFromClient = (
  name: string,
  isHeld: () => Promise<boolean>,
  client: CognitoIdentityProviderClient = cognitoClient,
): Promise<void> =>
  updateClientProviders((desired) => void desired.delete(name), isHeld, client);
