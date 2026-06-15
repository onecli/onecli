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
export const validateToken = async (token: string): Promise<void> => {
  const client = await getClient(token);
  try {
    await client.vaults.list();
  } catch (err) {
    clients.delete(tokenKey(token));
    throw new ServiceError(
      "BAD_REQUEST",
      `1Password token validation failed: ${errMessage(err)}`,
    );
  }
};

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
): Promise<string> => {
  const client = await getClient(token);
  try {
    return await client.secrets.resolve(opRef);
  } catch (err) {
    logger.warn({ opRef, err: errMessage(err) }, "1Password resolve failed");
    throw new ServiceError(
      "BAD_REQUEST",
      `cannot resolve ${opRef}: ${errMessage(err)}`,
    );
  }
};

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
export const listVaults = async (token: string): Promise<OpVault[]> => {
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
};

/** List the items in a vault. */
export const listItems = async (
  token: string,
  vaultId: string,
): Promise<OpItem[]> => {
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
};

/**
 * List an item's field labels — NOT values. The plaintext `field.value` the SDK
 * returns stays in this process; only id/title/type/section reach the caller.
 */
export const getItemFields = async (
  token: string,
  vaultId: string,
  itemId: string,
): Promise<OpItemFields> => {
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
};
