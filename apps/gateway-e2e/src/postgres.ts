import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * A real PostgreSQL server behind TLS for the database front door suite,
 * and a real `psql` to talk to the gateway with. Both run in throwaway
 * PostgreSQL 18 containers, so the suite needs nothing but Docker.
 *
 * The server generates its own self-signed certificate at start (the
 * connection is stored with `sslmode=require`), and its `pg_hba.conf` admits
 * only TLS: the role `scram` with SCRAM-SHA-256 (so the gateway negotiates
 * channel binding) and the role `md5u` with MD5.
 */
const run = promisify(execFile);

/** The server image: the Debian build ships `openssl`, which the target
 *  needs to mint its certificate. */
const SERVER_IMAGE = "postgres:18";
/** The client image: just `psql`. */
const CLIENT_IMAGE = "postgres:18-alpine";

/** The password-authenticated roles the target server creates. */
export const TARGET_ROLES = {
  scram: { username: "scram", password: "scram-pw" },
  md5: { username: "md5u", password: "md5-pw" },
} as const;

/** The table the `scram` role owns, for write tests. */
export const TARGET_TABLE = "e2e_items";

const SERVER_SCRIPT = `
set -e
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \\
  -keyout /tmp/server.key -out /tmp/server.crt 2>/dev/null
chown postgres /tmp/server.key /tmp/server.crt
chmod 600 /tmp/server.key
cat > /docker-entrypoint-initdb.d/zz-onecli.sh <<'SQL'
psql -v ON_ERROR_STOP=1 -U postgres <<'EOF'
SET password_encryption = 'scram-sha-256';
CREATE ROLE scram LOGIN PASSWORD 'scram-pw';
SET password_encryption = 'md5';
CREATE ROLE md5u LOGIN PASSWORD 'md5-pw';
CREATE TABLE ${TARGET_TABLE} (id int);
ALTER TABLE ${TARGET_TABLE} OWNER TO scram;
EOF
printf 'local all all trust\\nhostssl all md5u all md5\\nhostssl all all all scram-sha-256\\n' \\
  > "$PGDATA/pg_hba.conf"
SQL
exec docker-entrypoint.sh postgres -c ssl=on \\
  -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key
`;

/** A running target server. */
export interface PostgresTarget {
  /** The host port its 5432 is published on (127.0.0.1). */
  readonly port: number;
  stop(): Promise<void>;
}

/** Start a TLS PostgreSQL server on a free host port; resolves once it
 *  accepts TLS logins. */
export const startPostgresTarget = async (): Promise<PostgresTarget> => {
  const name = `onecli-e2e-pg-${String(process.pid)}-${String(Date.now())}`;
  // No `--rm`: a server that fails to start keeps its logs for the error.
  await run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    "127.0.0.1::5432",
    "--entrypoint",
    "sh",
    SERVER_IMAGE,
    "-c",
    SERVER_SCRIPT,
  ]);
  const stop = async () => {
    await run("docker", ["rm", "-f", name]).catch(() => undefined);
  };
  try {
    await waitForTls(name);
    const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
    const port = Number(stdout.trim().split("\n")[0]?.split(":").pop());
    if (!Number.isInteger(port)) {
      throw new Error(`no published port: ${stdout}`);
    }
    return { port, stop };
  } catch (error) {
    const logs = await run("docker", ["logs", name]).then(
      ({ stdout, stderr }) => `${stdout}${stderr}`,
      () => "",
    );
    await stop();
    throw new Error(
      `the PostgreSQL target did not start: ${String(error)}\n${logs}`,
    );
  }
};

/** Wait until the server answers a TLS login over TCP (the init phase
 *  answers on its Unix socket before the real server listens). */
const waitForTls = async (name: string): Promise<void> => {
  const { username, password } = TARGET_ROLES.scram;
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await run("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      name,
      "psql",
      `host=127.0.0.1 user=${username} dbname=postgres sslmode=require`,
      "-Atc",
      "SELECT 1",
    ]).then(
      () => true,
      () => false,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the PostgreSQL target never accepted a TLS login");
};

export interface PsqlResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface PsqlOptions {
  readonly sslmode?: string;
  readonly database?: string;
  /** Feed the commands to psql as a script on stdin (meta-commands such as
   *  `\bind` run only there) instead of one `-c` each. */
  readonly script?: boolean;
}

/**
 * Run `psql` against the gateway listening on `port` on this host, logging
 * in as connection `user` with the agent's OneCLI `token`. Each command is
 * its own `-c` unless `script`, so one refusal does not hide what the
 * session does next. Never throws: a failed run returns what psql printed.
 */
export const psql = async (
  port: number,
  user: string,
  token: string,
  commands: ReadonlyArray<string>,
  options: PsqlOptions = {},
): Promise<PsqlResult> => {
  const script = options.script === true;
  const env = clientEnv(port, user, token, options);
  return inClient(
    env,
    [
      "psql",
      env.CONNINFO,
      "-X",
      "-At",
      ...(script ? [] : commands.flatMap((command) => ["-c", command])),
    ],
    script ? `${commands.join("\n")}\n` : "",
  );
};

/**
 * Run a shell `command` in the client container with `$CONNINFO` set to the
 * gateway session `psql` would open, for a test that must drive psql itself
 * (signal it, run it in the background).
 */
export const psqlShell = async (
  port: number,
  user: string,
  token: string,
  command: string,
): Promise<PsqlResult> =>
  inClient(clientEnv(port, user, token, {}), ["sh", "-c", command], "");

/** The environment that points libpq at the gateway on this host. */
const clientEnv = (
  port: number,
  user: string,
  token: string,
  options: PsqlOptions,
): { PGPASSWORD: string; CONNINFO: string } => ({
  PGPASSWORD: token,
  CONNINFO: [
    "host=host.docker.internal",
    `port=${String(port)}`,
    `user=${user}`,
    `dbname=${options.database ?? "postgres"}`,
    `sslmode=${options.sslmode ?? "require"}`,
  ].join(" "),
});

/** Run `argv` in a throwaway client container with `env`, feeding it
 *  `stdin`. Never throws: a failed run returns what it printed. */
const inClient = async (
  env: Readonly<Record<string, string>>,
  argv: ReadonlyArray<string>,
  stdin: string,
): Promise<PsqlResult> => {
  const child = run(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--add-host=host.docker.internal:host-gateway",
      ...Object.entries(env).flatMap(([name, value]) => [
        "-e",
        `${name}=${value}`,
      ]),
      CLIENT_IMAGE,
      ...argv,
    ],
    { timeout: 60_000 },
  );
  child.child.stdin?.end(stdin);
  try {
    const { stdout, stderr } = await child;
    return { stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};
