import { ensureOrgAwsExternalId } from "../services/aws-external-id-service";
import type { AppDefinition, ConnectionMethod, ServerField } from "./types";

/** Request body accepted by the direct-connect endpoints (workspace and org). */
export interface ConnectRequestBody {
  fields?: Record<string, string>;
  connectionId?: string;
  label?: string;
  method?: string;
}

/** A connection method that accepts direct credentials (not OAuth). */
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
 * Resolve the values of an app's `serverFields` from the caller's authenticated
 * scope. Every source reads a fact about the CALLER'S OWN organization, so a
 * client cannot influence the result by what it submits.
 */
const resolveServerFields = async (
  serverFields: ServerField[],
  organizationId: string,
): Promise<Record<string, string>> => {
  const resolved: Record<string, string> = {};
  for (const field of serverFields) {
    switch (field.source) {
      case "orgAwsExternalId":
        resolved[field.name] = await ensureOrgAwsExternalId(organizationId);
        break;
      default: {
        // Exhaustiveness guard: a new source that lands here would otherwise
        // resolve to nothing and silently let the CLIENT'S value stand — the
        // exact failure this seam exists to prevent. Fail the connect instead.
        const unhandled: never = field.source;
        throw new Error(`Unhandled server field source: ${String(unhandled)}`);
      }
    }
  }
  return resolved;
};

/**
 * Resolve a direct-connect request body into stored credentials: pick the
 * connection method, validate the submitted fields, and exchange/shape them
 * into `{credentials, scopes, metadata}`. Shared by the workspace-scoped
 * (`POST /apps/:provider/connect`) and org-scoped
 * (`POST /org/apps/:provider/connect`) endpoints — every guard returns the
 * exact error string the workspace endpoint has always produced, so extraction
 * is behavior-preserving.
 *
 * `organizationId` is the CALLER'S org, from the auth context. It is what any
 * declared `serverFields` resolve against: those names are stripped from the
 * submitted fields and re-filled server-side, so a forged value in the request
 * body is discarded rather than trusted.
 */
export const resolveConnectCredentials = async (
  provider: string,
  appDef: AppDefinition,
  body: ConnectRequestBody | null,
  organizationId: string,
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

  if (!body?.fields) {
    return { ok: false, error: "Missing fields in request body" };
  }

  // Server-owned fields are resolved from the caller's org and MERGED OVER the
  // submitted ones, so whatever the client sent under those names never reaches
  // `exchangeCredentials` — the point of declaring them (see `ServerField`).
  // Resolved before validation, so a server-filled field satisfies a required
  // check the client cannot satisfy itself.
  const serverFields =
    activeMethod.type === "credentials_import"
      ? (activeMethod.serverFields ?? [])
      : [];
  const fields = {
    ...body.fields,
    ...(serverFields.length
      ? await resolveServerFields(serverFields, organizationId)
      : {}),
  };

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
      // Trimmed: the required-field check above already tests `.trim()`, so a
      // key pasted with a trailing newline passes validation — and would then
      // be stored and injected VERBATIM, which upstreams reject (Stripe
      // answers 401 for `Bearer rk_… `). Surrounding whitespace is never
      // meaningful in a credential, and HTTP strips it around header values
      // anyway, so normalizing here turns a silently-dead connection into a
      // working one.
      access_token: fields[primaryField!.name]?.trim(),
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
