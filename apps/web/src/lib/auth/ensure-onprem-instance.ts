import { db } from "@onecli/db";
import { ensureSharedOrgWithKey } from "@onecli/api/services/organization-service";
import { LOCAL_AUTH_ID, LOCAL_USER } from "./local-user";

/**
 * Eager onprem boot init (ORG-LEVEL only): ensure the bootstrap admin user, the
 * single shared organization, and the operator org API key exist — so the
 * instance is provisionable via the org key immediately after `docker run`,
 * before anyone opens the web.
 *
 * Runs for any onprem auth mode. Under local auth the bootstrap user IS the login
 * identity (`admin@localhost`); under OAuth it's just the operator key's owner,
 * and real users join the shared org on their first OAuth login.
 *
 * Projects + agents are deliberately NOT seeded here; they're created on demand
 * (first web login, or `POST /v1/projects` with the org key). Idempotent — safe
 * to run on every boot. Mirrors the org-level slice of the first-login flow
 * (`ensureLocalUser` + `joinSharedOrganization`).
 */
export const ensureOnpremInstance = async (): Promise<void> => {
  const user = await db.user.upsert({
    where: { externalAuthId: LOCAL_AUTH_ID },
    create: {
      externalAuthId: LOCAL_AUTH_ID,
      email: LOCAL_USER.email,
      name: LOCAL_USER.name,
    },
    update: {},
    select: { id: true, email: true },
  });

  await ensureSharedOrgWithKey(user.id, user.email);
};
