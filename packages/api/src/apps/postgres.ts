import type { AppDefinition } from "./types";
import {
  DATABASE_TARGET_METADATA_KEY,
  DATABASE_TLS_MODES,
  DATABASE_TLS_TAGS,
  type DatabaseTarget,
  type DatabaseTlsMode,
} from "../lib/connection-display";

/**
 * PostgreSQL. Not an HTTP app: agents connect with `psql` or any driver to
 * the gateway's database front door, which logs in to the real server with
 * these stored settings and judges every statement against the agent's
 * rules. The agent never holds the password; it names the connection by id
 * and proves who it is with its OneCLI token.
 *
 * The gateway reads the stored fields by these exact names
 * (`dbproxy::target::DbTarget`): `host`, `port`, `database`, `username`,
 * `password`, `sslmode` (`verify-full` | `require` | `disable`),
 * `sslrootcert`. It re-validates each one before dialing; the checks here
 * make a mistake visible at connect time instead of on the agent's first
 * session.
 */

const DEFAULT_PORT = "5432";

const isSslMode = (value: string): value is DatabaseTlsMode =>
  (DATABASE_TLS_MODES as readonly string[]).includes(value);

/** A bare hostname (any case, a single label allowed for a private network
 *  name) or an IP literal. The gateway applies the same rule. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+(?:%[0-9a-z]+)?$/i;

const isDialableHost = (host: string): boolean =>
  HOSTNAME.test(host) ||
  IPV4.test(host) ||
  (host.includes(":") && IPV6.test(host));

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/**
 * Validate the form and derive the connection's display metadata. Throws a
 * message the connect window shows. Never echoes the password.
 */
const resolveMetadata = async (
  fields: Record<string, string>,
): Promise<Record<string, unknown>> => {
  const host = (fields.host ?? "").trim();
  if (!isDialableHost(host)) {
    throw new Error(
      "Host must be a hostname or IP address only, without a scheme, port, or path (e.g. db.example.com)",
    );
  }
  const port = Number((fields.port ?? "").trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be a number from 1 to 65535");
  }
  const database = (fields.database ?? "").trim();
  if (!database || database.includes("\0")) {
    throw new Error("Database is required");
  }
  const sslmode = (fields.sslmode ?? "").trim();
  if (!isSslMode(sslmode)) {
    throw new Error('TLS must be "verify-full", "require" or "disable"');
  }
  const ca = (fields.sslrootcert ?? "").trim();
  if (sslmode === "verify-full" && ca && !PEM_CERTIFICATE.test(ca)) {
    throw new Error(
      "CA certificate must be PEM, starting with -----BEGIN CERTIFICATE-----",
    );
  }
  // The name is what every list shows, so it stays short: the database, the
  // way a client names a saved favorite. Where it lives rides as `target`
  // (never the password), shown under the name and used to prefill a
  // reconnect and to recognise the same login connected twice.
  const target: DatabaseTarget = {
    host,
    port,
    database,
    username: (fields.username ?? "").trim(),
  };
  return {
    name: database,
    [DATABASE_TARGET_METADATA_KEY]: target,
    tags: [DATABASE_TLS_TAGS[sslmode]],
  };
};

export const postgres: AppDefinition = {
  id: "postgres",
  name: "PostgreSQL",
  icon: "/icons/postgresql.svg",
  apiDocsUrl: "https://www.postgresql.org/docs/current/sql-commands.html",
  description:
    "Query a PostgreSQL database with each statement checked against your rules.",
  connectionMethod: {
    type: "api_key",
    // The password comes first: the connect handler stores fields[0] as the
    // connection's `access_token`, which the database front door never reads
    // but every credential row carries.
    fields: [
      {
        name: "password",
        label: "Password",
        description: "Agents never see this password.",
        placeholder: "••••••••",
        secret: true,
      },
      {
        name: "host",
        label: "Host",
        placeholder: "db.example.com",
        secret: false,
      },
      {
        name: "port",
        label: "Port",
        placeholder: DEFAULT_PORT,
        secret: false,
        optional: true,
      },
      {
        name: "database",
        label: "Database",
        placeholder: "app",
        secret: false,
      },
      {
        name: "username",
        label: "Username",
        description: "Use a database user with only the access agents need.",
        placeholder: "agent_readonly",
        secret: false,
      },
      {
        name: "sslmode",
        label: "TLS",
        placeholder: "Choose how to check the server",
        options: [
          { value: "verify-full", label: "Verify the server certificate" },
          {
            value: "require",
            label: "Encrypt only (no certificate verification)",
          },
          {
            value: "disable",
            label: "No encryption (not recommended)",
            warning:
              "Queries and results cross the internet readable, and anyone on the network path can change them. Only a SCRAM-SHA-256 login is allowed, so the password itself is never sent, but an observer can still try to guess a weak one. Prefer turning on SSL on the server, and use a strong password and a read-only user.",
          },
        ],
        defaultValue: "require",
        optional: true,
      },
      {
        name: "sslrootcert",
        label: "CA certificate",
        description:
          "Only for a private CA. Upload its PEM certificate (.pem or .crt). Leave empty for a public CA.",
        placeholder: "-----BEGIN CERTIFICATE-----",
        secret: false,
        optional: true,
        showWhen: { field: "sslmode", value: "verify-full" },
        fileUpload: {
          accept: ".pem,.crt,.cer,application/x-pem-file",
          label: "Upload certificate",
        },
      },
    ],
    resolveMetadata,
  },
  labelHint: 'e.g. "Orders (prod, read-only)"',
  database: { engine: "postgres" },
};
