/**
 * Internal endpoints the gateway calls to delegate 1Password SDK work.
 * Guarded by the shared-secret middleware (not user auth). Served at
 * `/v1/internal/*`. Errors propagate to the root app's error handler.
 */
import { Hono } from "hono";
import { z } from "zod";

import { internalAuth } from "../middleware/internal-auth";
import { ServiceError } from "../services/errors";
import {
  getItemFields,
  listItems,
  listVaults,
  resolveSecret,
  validateToken,
} from "../services/onepassword-service";
import type { ApiEnv } from "../types";
import {
  listFieldsSchema,
  listItemsSchema,
  listVaultsSchema,
  resolveSchema,
  validateTokenSchema,
} from "../validations/internal";

/** Validate a JSON body against a schema, surfacing the first issue as a 400. */
const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ServiceError(
      "BAD_REQUEST",
      parsed.error.issues[0]?.message ?? "invalid request",
    );
  }
  return parsed.data;
};

export const internalRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", internalAuth);

  // POST /v1/internal/onepassword/validate — { token }
  app.post("/onepassword/validate", async (c) => {
    const { token } = parseBody(
      validateTokenSchema,
      await c.req.json().catch(() => ({})),
    );
    await validateToken(token);
    return c.json({ valid: true });
  });

  // POST /v1/internal/onepassword/resolve — { token, op_ref }
  app.post("/onepassword/resolve", async (c) => {
    const { token, op_ref } = parseBody(
      resolveSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json({ value: await resolveSecret(token, op_ref) });
  });

  // ── Picker: browse vaults → items → fields (values never leave Node) ──

  app.post("/onepassword/list-vaults", async (c) => {
    const { token } = parseBody(
      listVaultsSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json({ vaults: await listVaults(token) });
  });

  app.post("/onepassword/list-items", async (c) => {
    const { token, vaultId } = parseBody(
      listItemsSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json({ items: await listItems(token, vaultId) });
  });

  app.post("/onepassword/list-fields", async (c) => {
    const { token, vaultId, itemId } = parseBody(
      listFieldsSchema,
      await c.req.json().catch(() => ({})),
    );
    return c.json(await getItemFields(token, vaultId, itemId));
  });

  return app;
};
