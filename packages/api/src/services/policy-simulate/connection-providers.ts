import { db } from "@onecli/db";

// The TS mirror of the gateway's `find_connection_providers`
// (apps/gateway/crates/db/src/lib.rs): the providers of the acting org+workspace app
// connections, so a `connection` target can resolve to the provider whose
// catalog hosts it gates (the step-8 secret symmetry). ORG+WORKSPACE-FENCED on
// both arms — a forged/foreign connection id resolves to NOTHING (it simply
// isn't in the fenced set), which leaves the target unresolved (never matches —
// fail-closed, like a deleted secret). No status filter: the row's existence is
// the reference, matching the gateway.

export const loadConnectionProviders = async (
  organizationId: string,
  workspaceId: string,
): Promise<Map<string, string>> => {
  const rows = await db.appConnection.findMany({
    where: {
      OR: [{ workspaceId }, { organizationId, scope: "organization" }],
    },
    select: { id: true, provider: true },
  });
  return new Map(rows.map((row) => [row.id, row.provider]));
};
