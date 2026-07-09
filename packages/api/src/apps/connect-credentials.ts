import type { AppDefinition, ConnectionMethod } from "./types";

/** Request body accepted by the direct-connect endpoints (project and org). */
export interface ConnectRequestBody {
  fields?: Record<string, string>;
  connectionId?: string;
  label?: string;
  method?: string;
}

/** A connection method that accepts direct credentials (not OAuth/cloud-only). */
export type DirectConnectionMethod = Extract<
  ConnectionMethod,
  { type: "api_key" | "credentials_import" }
>;

export type ResolvedConnectCredentials =
  | { ok: false; error: string }
  | {
      ok: true;
      credentials: Record<string, unknown>;
      scopes?: string[];
      metadata?: Record<string, unknown>;
      activeMethod: DirectConnectionMethod;
      fields: Record<string, string>;
    };

/**
 * Resolve a direct-connect request body into stored credentials: pick the
 * connection method, validate the submitted fields, and exchange/shape them
 * into `{credentials, scopes, metadata}`. Shared by the project-scoped
 * (`POST /apps/:provider/connect`) and org-scoped
 * (`POST /org/apps/:provider/connect`) endpoints — every guard returns the
 * exact error string the project endpoint has always produced, so extraction
 * is behavior-preserving.
 */
export const resolveConnectCredentials = async (
  provider: string,
  appDef: AppDefinition,
  body: ConnectRequestBody | null,
): Promise<ResolvedConnectCredentials> => {
  // Resolve which connection method to use. Apps with `additionalMethods`
  // (e.g. Attio: OAuth primary + API key alternate) pass `method` to select
  // one; otherwise the primary `connectionMethod` is used. An explicit but
  // unrecognized `method` is rejected rather than silently falling back.
  const requestedMethod = body?.method;
  const activeMethod = requestedMethod
    ? ((appDef.additionalMethods ?? []).find(
        (m) => m.type === requestedMethod,
      ) ??
      (appDef.connectionMethod.type === requestedMethod
        ? appDef.connectionMethod
        : undefined))
    : appDef.connectionMethod;

  if (!activeMethod) {
    return {
      ok: false,
      error: `Provider "${provider}" has no "${requestedMethod}" connection method`,
    };
  }

  if (activeMethod.type === "oauth") {
    return {
      ok: false,
      error: `Provider "${provider}" uses OAuth flow, not direct credentials`,
    };
  }

  if (activeMethod.type === "cloud_only") {
    return {
      ok: false,
      error: `Provider "${provider}" is only available in OneCLI Cloud`,
    };
  }

  if (!body?.fields) {
    return { ok: false, error: "Missing fields in request body" };
  }

  const { fields } = body;

  let requiredFields: { name: string; label: string }[];
  if (
    activeMethod.type === "credentials_import" &&
    activeMethod.fields.some((f) => f.group)
  ) {
    requiredFields = activeMethod.fields.filter((f) => {
      if (!f.group) return true;
      if (fields.privateKey) return f.group === "service_account";
      return f.group === "authorized_user";
    });
  } else {
    requiredFields = activeMethod.fields.filter(
      (f) => !("optional" in f && f.optional),
    );
  }

  for (const field of requiredFields) {
    if (!fields[field.name]?.trim()) {
      return { ok: false, error: `${field.label} is required` };
    }
  }

  let credentials: Record<string, unknown>;
  let scopes: string[] | undefined;
  let metadata: Record<string, unknown> | undefined;

  if (activeMethod.type === "credentials_import") {
    const result = await activeMethod.exchangeCredentials(fields);
    credentials = result.credentials;
    scopes = result.scopes;
    metadata = result.metadata;
  } else {
    const primaryField = activeMethod.fields[0];
    credentials = {
      access_token: fields[primaryField!.name],
      ...fields,
    };

    if (activeMethod.resolveMetadata) {
      try {
        metadata = (await activeMethod.resolveMetadata(fields)) ?? undefined;
      } catch (e) {
        return {
          ok: false,
          error:
            e instanceof Error
              ? e.message
              : "Could not validate the provided credentials",
        };
      }
    }

    if (!metadata) {
      metadata = { name: "API Key" };
    }
  }

  return { ok: true, credentials, scopes, metadata, activeMethod, fields };
};
