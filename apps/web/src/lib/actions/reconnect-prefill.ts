"use server";

import { db } from "@onecli/db";
import {
  asRecord,
  connectionTags,
  databaseTlsModeFromTags,
  extractDatabaseTarget,
  extractLabel,
  parseLegacyDatabaseName,
  type DatabaseTarget,
} from "@onecli/api/lib/connection-display";
import { scopeOwnership } from "@onecli/api/services/resource-scope";
import {
  resolveOrgContext,
  resolveWorkspaceContext,
} from "@/lib/actions/resolve-user";

/** What a reconnect form starts with: the fields the user typed last time
 *  (never a secret), and the connection's current name. */
export interface ReconnectPrefill {
  fields: Record<string, string>;
  label: string | null;
}

/**
 * The previous non-secret values of a database connection being reconnected,
 * read from its metadata (the encrypted credentials are never opened here).
 * Fenced like every popup read: the connection must sit in the caller's own
 * workspace, or in its org when the popup carries an orgId. Anything else,
 * or an older connection saved without a recorded target, is null: the form
 * simply starts empty, as before.
 */
export const getReconnectPrefill = async (
  provider: string,
  connectionId: string,
  orgId?: string,
): Promise<ReconnectPrefill | null> => {
  try {
    const scope = orgId
      ? { organizationId: (await resolveOrgContext()).organizationId }
      : { workspaceId: (await resolveWorkspaceContext()).workspaceId };
    const connection = await db.appConnection.findFirst({
      where: { ...scopeOwnership(scope, connectionId), provider },
      select: { label: true, metadata: true },
    });
    if (!connection) return null;
    const metadata = asRecord(connection.metadata) ?? undefined;
    // A connection saved before the target was recorded still names it in
    // the generated `<database> on <host>` (no port or user to recover).
    const target:
      | (Partial<DatabaseTarget> & Pick<DatabaseTarget, "host" | "database">)
      | null =
      extractDatabaseTarget(metadata) ??
      parseLegacyDatabaseName(metadata?.name);
    if (!target) return null;
    const sslmode = databaseTlsModeFromTags(connectionTags(metadata));
    return {
      // Only a name the user chose. A generated one (the database, or the
      // old `db on host`) is left out so a reconnect regenerates it.
      label:
        connection.label && connection.label !== extractLabel(metadata)
          ? connection.label
          : null,
      fields: {
        host: target.host,
        database: target.database,
        ...(target.port ? { port: String(target.port) } : {}),
        ...(target.username ? { username: target.username } : {}),
        ...(sslmode ? { sslmode } : {}),
      },
    };
  } catch {
    // Auth not resolved or no access: no prefill, never an error page.
    return null;
  }
};
