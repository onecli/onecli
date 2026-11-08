import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

import {
  SANDBOX_PG_PASS_FILE,
  SANDBOX_PG_SERVICE_FILE,
  type AgentConnectionWire,
} from "@onecli/agent-protocol";

import { log } from "./log";
import type { GatewayTarget } from "./open-proxy";

/**
 * The agent's attached databases as libpq sees them: one service per
 * connection in a service file, and the agent's OneCLI token in a password
 * file, so `psql "service=<name>"` (and every libpq-based driver) logs in
 * to the gateway's database front door with no flags and no secret on the
 * command line.
 *
 * The gateway answers PostgreSQL on the same host and port as its proxy
 * (it tells the protocols apart by their first byte), presents a
 * certificate from the same CA the sandbox already trusts, and logs in to
 * the real server itself. The agent never holds the database password: its
 * user name is the connection id and its password is its own token.
 *
 * The files live on the ephemeral /tmp, never the durable home, and the
 * environment that points libpq at them (`PGSERVICEFILE`, `PGPASSFILE`,
 * `PGSSLROOTCERT`) is part of the container's own (the container-config
 * payload), so every shell and driver finds them.
 */

const MAX_SERVICE_NAME_CHARS = 63;

/** One attached database, as an agent names it. */
export interface PgService {
  /** The libpq service name: the connection's label when it makes a usable
   *  name, else the connection id. Unique across the agent's databases. */
  readonly name: string;
  readonly connectionId: string;
  /** The connection this service stands for. */
  readonly connection: AgentConnectionWire;
}

/** The PostgreSQL connections in `connections`, each with its service
 *  name. Pure: the renderer names the same services the files define. */
export const pgServices = (
  connections: readonly AgentConnectionWire[],
): PgService[] => {
  const services: PgService[] = [];
  const taken = new Set<string>();
  for (const connection of connections) {
    const database = connection.database;
    if (database?.engine !== "postgres") continue;
    const fromLabel = (connection.label ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SERVICE_NAME_CHARS);
    const name =
      fromLabel && !taken.has(fromLabel) ? fromLabel : database.connectionId;
    taken.add(name);
    services.push({ name, connectionId: database.connectionId, connection });
  }
  return services;
};

/** A pgpass field: `:` and `\` are the format's own delimiters. */
const pgpassField = (value: string): string => value.replace(/[\\:]/g, "\\$&");

/** The contents of the two files for `services`, through `gateway`. */
export const pgFiles = (
  services: readonly PgService[],
  gateway: GatewayTarget,
): { serviceFile: string; passFile: string } => ({
  serviceFile: services
    .map((service) =>
      [
        `[${service.name}]`,
        `host=${gateway.host}`,
        `port=${String(gateway.port)}`,
        `user=${service.connectionId}`,
        `dbname=${service.connectionId}`,
        // The gateway's certificate chains to the CA the sandbox trusts
        // (`PGSSLROOTCERT`); its name is fixed, never the proxy host's.
        "sslmode=verify-ca",
        "",
      ].join("\n"),
    )
    .join("\n"),
  passFile: services
    .map(
      (service) =>
        `${[
          pgpassField(gateway.host),
          String(gateway.port),
          "*",
          pgpassField(service.connectionId),
          pgpassField(gateway.token),
        ].join(":")}\n`,
    )
    .join(""),
});

/**
 * Keeps the two files in step with the agent's connections. Each write is
 * atomic (a fresh exclusive temp file renamed over the old one), so a
 * client reading mid-update sees the old file or the new one, never a
 * half; and `rename` replaces a planted symlink rather than following it,
 * so the token can never land anywhere but its own owner-only file. A file
 * whose content did not change is not touched. `paths` is the files' home,
 * the shared sandbox paths unless a test names its own.
 */
export const createPgFilesWriter = (
  gateway: GatewayTarget | undefined,
  paths: { service: string; pass: string } = {
    service: SANDBOX_PG_SERVICE_FILE,
    pass: SANDBOX_PG_PASS_FILE,
  },
) => {
  const written = new Map<string, string>();
  const write = (path: string, contents: string, mode: number): void => {
    if (written.get(path) === contents) return;
    const temp = `${path}.${randomBytes(6).toString("hex")}`;
    try {
      if (contents) {
        writeFileSync(temp, contents, { mode, flag: "wx" });
        renameSync(temp, path);
      } else {
        rmSync(path, { force: true });
      }
      written.set(path, contents);
    } catch (error) {
      rmSync(temp, { force: true });
      // Best-effort: the agent loses the shortcut, never its session.
      log("warn", "could not write a libpq file", {
        path,
        error: String(error),
      });
    }
  };
  return (connections: readonly AgentConnectionWire[]): void => {
    // No gateway proxy in the environment (local dev): nothing to reach.
    if (!gateway) return;
    const files = pgFiles(pgServices(connections), gateway);
    write(paths.service, files.serviceFile, 0o644);
    write(paths.pass, files.passFile, 0o600);
  };
};
