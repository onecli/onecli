import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Two public outputs this change moved, on REAL PostgreSQL through the REAL
 * HTTP stack (auth middleware, key lookup, audit write):
 *
 *   1. `GET /v1/counts` answers exactly its four counts, fenced to the
 *      caller's workspace (`agentsWorkingInBackground` is gone: its only
 *      reader was the dashboard Overview).
 *   2. `POST /v1/user/api-key/regenerate` (the dashboard's API Key page and
 *      the CLI share it) rotates the caller's key in the database, the old
 *      key stops authenticating at once, the new one works, the rotation is
 *      audited with ids only, and another tenant's key is untouched.
 *
 * Env-gated like the other proof suites (see `pg-proof.ts`).
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;

const P = "keycountsproof-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WS = `${P}ws`;
const OTHER_WS = `${P}other-ws`;
const USER = `${P}user`;
const OTHER_USER = `${P}other-user`;
const KEY = `oc_${P}ws-key`;
const OTHER_KEY = `oc_${P}other-key`;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe.skipIf(!PROOF_URL)(
  "API key rotation and counts (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      process.env.NEXT_PUBLIC_EDITION = "onprem";
      ({ db } = await import("@onecli/db"));
      const { createApiApp } = await import("../app.js");
      app = createApiApp({ getSession: async () => null });
    });

    beforeEach(async () => {
      await db.auditLog.deleteMany({
        where: { userId: { in: [USER, OTHER_USER] } },
      });
      await db.agent.deleteMany({
        where: { workspaceId: { in: [WS, OTHER_WS] } },
      });
      await db.apiKey.deleteMany({
        where: { userId: { in: [USER, OTHER_USER] } },
      });
      await db.workspace.deleteMany({ where: { id: { in: [WS, OTHER_WS] } } });
      await db.organizationMember.deleteMany({
        where: { organizationId: { in: [ORG, OTHER_ORG] } },
      });
      await db.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
      await db.organization.deleteMany({
        where: { id: { in: [ORG, OTHER_ORG] } },
      });

      for (const [org, user, ws, key] of [
        [ORG, USER, WS, KEY],
        [OTHER_ORG, OTHER_USER, OTHER_WS, OTHER_KEY],
      ] as const) {
        await db.organization.create({
          data: { id: org, name: org, slug: `${org}-slug` },
        });
        await db.user.create({
          data: {
            id: user,
            email: `${user}@example.com`,
            externalAuthId: `${user}-auth`,
          },
        });
        await db.organizationMember.create({
          data: {
            organizationId: org,
            userId: user,
            userEmail: `${user}@example.com`,
            role: "owner",
          },
        });
        await db.workspace.create({
          data: { id: ws, name: ws, organizationId: org },
        });
        await db.apiKey.create({
          data: {
            key,
            userId: user,
            userEmail: `${user}@example.com`,
            workspaceId: ws,
            scope: "workspace",
          },
        });
      }
      // Two agents in the caller's workspace, one in the other tenant's.
      for (const [id, ws] of [
        [`${P}a1`, WS],
        [`${P}a2`, WS],
        [`${P}b1`, OTHER_WS],
      ] as const) {
        await db.agent.create({
          data: {
            id,
            name: id,
            identifier: id,
            workspaceId: ws,
            accessToken: `aoc_${id}`,
          },
        });
      }
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    it("GET /v1/counts answers exactly its four counts, fenced to the caller's workspace", async () => {
      const res = await app.request("/v1/counts", { headers: auth(KEY) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "agents",
        "apps",
        "llms",
        "secrets",
      ]);
      expect(body.agents).toBe(2);
    });

    it("regenerate rotates the key in the database, cuts the old one off, and audits ids only", async () => {
      const res = await app.request("/v1/user/api-key/regenerate", {
        method: "POST",
        headers: auth(KEY),
      });
      expect(res.status).toBe(200);
      const { apiKey } = (await res.json()) as { apiKey: string };
      expect(apiKey).toMatch(/^oc_[0-9a-f]{64}$/);
      expect(apiKey).not.toBe(KEY);

      // The row now holds the new key; the old value no longer exists.
      const rows = await db.apiKey.findMany({
        where: { userId: USER, workspaceId: WS, kind: "user" },
        select: { key: true },
      });
      expect(rows).toEqual([{ key: apiKey }]);

      // The old key is refused at once; the new one authenticates.
      expect(
        (await app.request("/v1/user/api-key", { headers: auth(KEY) })).status,
      ).toBe(401);
      const read = await app.request("/v1/user/api-key", {
        headers: auth(apiKey),
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ apiKey });

      // Audited, with ids only: never the old or the new key.
      const audits = await db.auditLog.findMany({
        where: { userId: USER, action: "regenerate", service: "api-key" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ workspaceId: WS, source: "api" });
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain(apiKey);
      expect(serialized).not.toContain(KEY);

      // Another tenant's key is untouched.
      const other = await db.apiKey.findUnique({
        where: { key: OTHER_KEY },
        select: { userId: true },
      });
      expect(other).toEqual({ userId: OTHER_USER });
    });
  },
);
