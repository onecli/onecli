/**
 * 1Password SDK service — the only place that talks to 1Password.
 *
 * The gateway holds the (decrypted) Service-Account token and sends it with
 * each call, so this service is a stateless `token + op:// → value` function;
 * it never reads our database. SDK clients are cached by a hash of the token
 * to avoid re-initializing the WASM core on every request.
 */
import { createClient, type Client } from "@1password/sdk";
import { createHash } from "node:crypto";
import {
  Agent,
  fetch as undiciFetch,
  Headers as undiciHeaders,
  Request as undiciRequest,
  Response as undiciResponse,
} from "undici";

import { logger } from "../lib/logger";
import { ServiceError } from "./errors";

const INTEGRATION_NAME = "OneCLI";
const INTEGRATION_VERSION = "1.0.0";
/** Evict cached SDK clients idle longer than this. */
const CLIENT_IDLE_TTL_MS = 30 * 60 * 1000;

interface CachedClient {
  client: Client;
  lastUsed: number;
}

const clients = new Map<string, CachedClient>();

const tokenKey = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Node's fetch (undici) puts the real failure in `err.cause`; the 1Password SDK
// hides it behind a vague "error sending request", so surface the cause for logs.
const errCause = (err: unknown): string | undefined => {
  const cause = (err as { cause?: unknown }).cause;
  if (cause == null) return undefined;
  if (cause instanceof Error) return cause.message;
  const code = (cause as { code?: string }).code;
  return code ?? String(cause);
};

// ── undici isolation ────────────────────────────────────────────────────────
// The 1Password SDK's WASM core makes HTTP through the global fetch/Request/
// Response/Headers and undici's global dispatcher. Prisma (@onecli/db) bundles
// its own copy of undici and installs *its* Agent as the global dispatcher, so
// the SDK's fetch would stream response bodies from a different undici instance
// than the one decoding them and fail with "request library compatibility issue:
// error sending request". We pin every SDK call onto one self-consistent undici
// (its fetch + Request/Response/Headers + a dedicated Agent passed per request,
// so the global dispatcher is never touched), restoring the originals after.
// See https://github.com/1Password/onepassword-sdk-js/issues/134.
const sdkAgent = new Agent();
const pinnedFetch = ((
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) =>
  undiciFetch(input, {
    ...init,
    dispatcher: sdkAgent,
  })) as unknown as typeof globalThis.fetch;

let pinDepth = 0;
let savedHttp: Pick<
  typeof globalThis,
  "fetch" | "Request" | "Response" | "Headers"
> | null = null;

/**
 * Run an SDK operation with a self-consistent undici pinned to the global HTTP
 * primitives. Reference-counted so concurrent calls share one swap window and
 * the originals are restored exactly once.
 */
const withPinnedUndici = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (pinDepth === 0) {
    savedHttp = {
      fetch: globalThis.fetch,
      Request: globalThis.Request,
      Response: globalThis.Response,
      Headers: globalThis.Headers,
    };
    globalThis.fetch = pinnedFetch;
    globalThis.Request = undiciRequest as unknown as typeof globalThis.Request;
    globalThis.Response =
      undiciResponse as unknown as typeof globalThis.Response;
    globalThis.Headers = undiciHeaders as unknown as typeof globalThis.Headers;
  }
  pinDepth++;
  try {
    return await fn();
  } finally {
    if (--pinDepth === 0 && savedHttp) {
      globalThis.fetch = savedHttp.fetch;
      globalThis.Request = savedHttp.Request;
      globalThis.Response = savedHttp.Response;
      globalThis.Headers = savedHttp.Headers;
      savedHttp = null;
    }
  }
};

const getClient = async (token: string): Promise<Client> => {
  const now = Date.now();
  const key = tokenKey(token);

  // Lazy idle-eviction (the set of active tokens is small).
  for (const [k, c] of clients) {
    if (now - c.lastUsed > CLIENT_IDLE_TTL_MS) clients.delete(k);
  }

  const cached = clients.get(key);
  if (cached) {
    cached.lastUsed = now;
    return cached.client;
  }

  let client: Client;
  try {
    client = await createClient({
      auth: token,
      integrationName: INTEGRATION_NAME,
      integrationVersion: INTEGRATION_VERSION,
    });
  } catch (err) {
    logger.warn(
      { err: errMessage(err), cause: errCause(err) },
      "1Password createClient failed",
    );
    throw new ServiceError(
      "BAD_REQUEST",
      `invalid 1Password service account token: ${errMessage(err)}`,
    );
  }
  clients.set(key, { client, lastUsed: now });
  return client;
};

/**
 * Validate a Service-Account token with a cheap connectivity check (vault list).
 * Used at pair time and for the gateway's `status` check.
 */
export const validateToken = async (token: string): Promise<void> =>
  withPinnedUndici(async () => {
    const client = await getClient(token);
    try {
      await client.vaults.list();
    } catch (err) {
      clients.delete(tokenKey(token));
      logger.warn(
        { err: errMessage(err), cause: errCause(err) },
        "1Password token validation failed",
      );
      throw new ServiceError(
        "BAD_REQUEST",
        `1Password token validation failed: ${errMessage(err)}`,
      );
    }
  });

/**
 * Resolve an `op://vault/item/field` reference to its secret value.
 *
 * Any resolution failure is surfaced as BAD_REQUEST so the gateway treats the
 * mapping as stale and backs off via its negative cache. Transport failures
 * (gateway → Node) are handled gateway-side and drive the longer cooldown.
 */
export const resolveSecret = async (
  token: string,
  opRef: string,
): Promise<string> =>
  withPinnedUndici(async () => {
    const client = await getClient(token);
    try {
      return await client.secrets.resolve(opRef);
    } catch (err) {
      logger.warn(
        { opRef, err: errMessage(err), cause: errCause(err) },
        "1Password resolve failed",
      );
      throw new ServiceError(
        "BAD_REQUEST",
        `cannot resolve ${opRef}: ${errMessage(err)}`,
      );
    }
  });

// ── Picker (browse vaults → items → fields) ──────────────────────────────

export interface OpVault {
  id: string;
  title: string;
}

export interface OpItem {
  id: string;
  title: string;
  category: string;
}

export interface OpField {
  id: string;
  title: string;
  fieldType: string;
  sectionId?: string;
}

export interface OpItemFields {
  fields: OpField[];
  sections: { id: string; title: string }[];
}

/** List the vaults the service account can read. */
export const listVaults = async (token: string): Promise<OpVault[]> =>
  withPinnedUndici(async () => {
    const client = await getClient(token);
    try {
      const vaults = await client.vaults.list();
      return vaults.map((v) => ({ id: v.id, title: v.title }));
    } catch (err) {
      throw new ServiceError(
        "BAD_REQUEST",
        `cannot list vaults: ${errMessage(err)}`,
      );
    }
  });

/** List the items in a vault. */
export const listItems = async (
  token: string,
  vaultId: string,
): Promise<OpItem[]> =>
  withPinnedUndici(async () => {
    const client = await getClient(token);
    try {
      // Active items only — never surface archived items in the picker.
      const items = await client.items.list(vaultId, {
        type: "ByState",
        content: { active: true, archived: false },
      });
      return items.map((i) => ({
        id: i.id,
        title: i.title,
        category: String(i.category),
      }));
    } catch (err) {
      throw new ServiceError(
        "BAD_REQUEST",
        `cannot list items: ${errMessage(err)}`,
      );
    }
  });

/**
 * List an item's field labels — NOT values. The plaintext `field.value` the SDK
 * returns stays in this process; only id/title/type/section reach the caller.
 */
export const getItemFields = async (
  token: string,
  vaultId: string,
  itemId: string,
): Promise<OpItemFields> =>
  withPinnedUndici(async () => {
    const client = await getClient(token);
    try {
      const item = await client.items.get(vaultId, itemId);
      return {
        fields: item.fields.map((f) => ({
          id: f.id,
          title: f.title,
          fieldType: String(f.fieldType),
          sectionId: f.sectionId,
        })),
        sections: item.sections.map((s) => ({ id: s.id, title: s.title })),
      };
    } catch (err) {
      throw new ServiceError(
        "BAD_REQUEST",
        `cannot read item: ${errMessage(err)}`,
      );
    }
  });
