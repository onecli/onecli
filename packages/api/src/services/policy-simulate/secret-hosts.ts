import { db } from "@onecli/db";

// The TS mirror of the gateway's `find_secret_hosts` (apps/gateway/src/db.rs):
// the host patterns of the acting org+project custom secrets, so a `secret`
// target can resolve to the host(s) it gates. ORG+PROJECT-FENCED on both arms —
// a forged/foreign secret id or scope resolves to NOTHING (it simply isn't in
// the fenced set), which the evaluator treats as never-matching (fail-closed).

export interface SecretHostSet {
  byId: Map<string, string>;
  projectHosts: string[];
  orgHosts: string[];
}

export const loadSecretHosts = async (
  organizationId: string,
  projectId: string,
): Promise<SecretHostSet> => {
  const rows = await db.secret.findMany({
    where: {
      OR: [{ projectId }, { organizationId, scope: "organization" }],
    },
    select: { id: true, hostPattern: true, scope: true },
  });
  const set: SecretHostSet = {
    byId: new Map(),
    projectHosts: [],
    orgHosts: [],
  };
  for (const row of rows) {
    if (row.scope === "project") set.projectHosts.push(row.hostPattern);
    if (row.scope === "organization") set.orgHosts.push(row.hostPattern);
    set.byId.set(row.id, row.hostPattern);
  }
  return set;
};
