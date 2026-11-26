import { getApp } from "@onecli/api/apps/registry";
import type { Connection, Secret } from "@/lib/api";

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

const appName = (connection: Connection) =>
  getApp(connection.provider)?.name ?? connection.provider;

const accountName = (connection: Connection) =>
  connection.label ?? appName(connection);

/**
 * The new agent's chooser reads as a catalog, not a history: connections are
 * grouped by app, A to Z by the app's display name, then by account within an
 * app. The agent's own page keeps the server's newest-first order (and its
 * pinned placement), so this only shapes the chooser.
 */
export const sortConnectionsForChooser = (
  connections: readonly Connection[],
): Connection[] =>
  [...connections].sort(
    (a, b) =>
      collator.compare(appName(a), appName(b)) ||
      collator.compare(accountName(a), accountName(b)) ||
      a.id.localeCompare(b.id),
  );

/** Custom connections in the chooser: A to Z by name. */
export const sortSecretsForChooser = <T extends Pick<Secret, "id" | "name">>(
  secrets: readonly T[],
): T[] =>
  [...secrets].sort(
    (a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id),
  );
