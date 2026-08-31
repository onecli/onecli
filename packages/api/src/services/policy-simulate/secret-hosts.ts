import { db } from "@onecli/db";

// The TS mirror of the gateway's `find_secret_hosts` (apps/gateway/crates/db/src/lib.rs):
// the host patterns of the acting org+workspace custom secrets, so a `secret`
// target can resolve to the host(s) it gates. ORG+WORKSPACE-FENCED on both arms —
// a forged/foreign secret id or scope resolves to NOTHING (it simply isn't in
// the fenced set), which the evaluator treats as never-matching (fail-closed).

export interface SecretHostSet {
  byId: Map<string, string>;
  workspaceHosts: string[];
  orgHosts: string[];
}

export const loadSecretHosts = async (
  organizationId: string,
  workspaceId: string,
): Promise<SecretHostSet> => {
  const rows = await db.secret.findMany({
    where: {
      OR: [{ workspaceId }, { organizationId, scope: "organization" }],
    },
    select: { id: true, hostPattern: true, scope: true },
  });
  const set: SecretHostSet = {
    byId: new Map(),
    workspaceHosts: [],
    orgHosts: [],
  };
  for (const row of rows) {
    if (row.scope === "workspace") set.workspaceHosts.push(row.hostPattern);
    if (row.scope === "organization") set.orgHosts.push(row.hostPattern);
    set.byId.set(row.id, row.hostPattern);
  }
  return set;
};
