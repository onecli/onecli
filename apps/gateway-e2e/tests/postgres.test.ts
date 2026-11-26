import { afterAll, beforeAll, describe, expect } from "vitest";

import { e2eConfig } from "../src/env.js";
import { errorOf, message, openWireSession } from "../src/pg-wire.js";
import {
  psql,
  psqlShell,
  startPostgresTarget,
  TARGET_ROLES,
  TARGET_TABLE,
  type PostgresTarget,
} from "../src/postgres.js";
import { scenario } from "../src/scenario.js";

/**
 * The PostgreSQL front door, end to end: a real `psql` speaks to the
 * gateway, which logs in to a real TLS PostgreSQL server with the stored
 * connection and judges every statement by the agent's rules. Both run in
 * containers (`src/postgres.ts`), so the suite needs only Docker beyond the
 * suite's usual database and Redis.
 */
let target: PostgresTarget | undefined;

beforeAll(async () => {
  if (e2eConfig() !== null) target = await startPostgresTarget();
}, 120_000);

afterAll(async () => {
  await target?.stop();
});

const connection = (role: keyof typeof TARGET_ROLES = "scram") => ({
  provider: "postgres",
  label: "orders-db",
  credentials: {
    host: "127.0.0.1",
    port: String(target?.port ?? 0),
    database: "postgres",
    ...TARGET_ROLES[role],
    sslmode: "require",
  },
});

/** Reads allowed, writes and schema changes blocked, on the one connection.
 *  The grant attaches the connection to the agent (it is what lists it at
 *  login); the spec rules sit ahead of the grant's own allow. */
const readsOnly = () => ({
  appConnections: [connection()],
  rules: [
    {
      name: "allow-reads",
      action: "allow" as const,
      targets: [
        { kind: "connection" as const, connectionIndex: 0, method: "GET" },
      ],
    },
    {
      name: "block-changes",
      action: "block" as const,
      targets: [
        { kind: "connection" as const, connectionIndex: 0, method: "!GET" },
      ],
    },
  ],
  grantAll: true,
});

const allowAll = (role: keyof typeof TARGET_ROLES = "scram") => ({
  appConnections: [connection(role)],
  rules: [
    {
      name: "allow-everything",
      action: "allow" as const,
      targets: [{ kind: "connection" as const, connectionIndex: 0 }],
    },
  ],
  grantAll: true,
});

const GATEWAY = { env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "127.0.0.1" } };

describe("postgres front door", () => {
  scenario(
    "reads run; writes and schema changes are blocked by rule",
    async (cx) => {
      await cx.seed(readsOnly());
      const gw = await cx.startGateway(GATEWAY);
      const user = `${cx.ids.workspace}-conn-0`;

      const read = await psql(gw.port, user, cx.ids.agentToken, [
        "SELECT 40 + 2",
      ]);
      expect(read.stderr).toBe("");
      expect(read.stdout.trim()).toBe("42");

      const changes = await psql(gw.port, user, cx.ids.agentToken, [
        `INSERT INTO ${TARGET_TABLE} VALUES (1)`,
        "CREATE TEMP TABLE t (a int)",
        "SELECT 'still here'",
      ]);
      expect(changes.stderr).toContain(
        'OneCLI blocked this write statement (rule "block-changes")',
      );
      expect(changes.stderr).toContain(
        'OneCLI blocked this schema change statement (rule "block-changes")',
      );
      expect(changes.stdout.trim()).toBe("still here");
    },
  );

  scenario(
    "forbidden statements are refused whatever the rules say",
    async (cx) => {
      await cx.seed(allowAll());
      const gw = await cx.startGateway(GATEWAY);
      const user = `${cx.ids.workspace}-conn-0`;
      const result = await psql(gw.port, user, cx.ids.agentToken, [
        "COPY (SELECT 1) TO PROGRAM 'id'",
        "SELECT pg_read_file('/etc/passwd')",
        "SET ROLE NONE",
        "BEGIN READ WRITE",
        "SELECT 7",
      ]);
      for (const why of [
        "it runs a program on the database server",
        "it reads or writes files on the database server",
        "it switches the database role",
        "it can turn off read-only transactions",
      ]) {
        expect(result.stderr).toContain(why);
      }
      // A refusal leaves the session usable.
      expect(result.stdout.trim()).toBe("7");
    },
  );

  scenario(
    "a refusal inside a transaction keeps the transaction",
    async (cx) => {
      await cx.seed(allowAll());
      const gw = await cx.startGateway(GATEWAY);
      const user = `${cx.ids.workspace}-conn-0`;
      // Nothing of the refused statement reached the server, so the
      // transaction is still open (not aborted) and assigned no id.
      const result = await psql(gw.port, user, cx.ids.agentToken, [
        "BEGIN",
        "SELECT pg_read_file('/x')",
        "SELECT txid_current_if_assigned() IS NULL, 8",
        "COMMIT",
      ]);
      expect(result.stderr).toContain("files on the database server");
      expect(result.stdout).toContain("t|8");
    },
  );

  scenario("prepared statements are judged by what they run", async (cx) => {
    await cx.seed(readsOnly());
    const gw = await cx.startGateway(GATEWAY);
    const user = `${cx.ids.workspace}-conn-0`;
    const sql = await psql(gw.port, user, cx.ids.agentToken, [
      `PREPARE w AS INSERT INTO ${TARGET_TABLE} VALUES (2); EXECUTE w`,
      "PREPARE r AS SELECT 5; EXECUTE r",
    ]);
    expect(sql.stderr).toContain("OneCLI blocked this write statement");
    // psql prints PREPARE's command tag, then the row the EXECUTE returns.
    expect(sql.stdout.trim().split("\n")).toEqual(["PREPARE", "5"]);

    // The extended protocol (Parse / Bind / Execute), through psql's \bind.
    const extended = await psql(
      gw.port,
      user,
      cx.ids.agentToken,
      [
        "SELECT $1::int + 1 \\bind 41 \\g",
        `INSERT INTO ${TARGET_TABLE} VALUES ($1) \\bind 3 \\g`,
      ],
      { script: true },
    );
    expect(extended.stdout.trim()).toBe("42");
    expect(extended.stderr).toContain("OneCLI blocked this write statement");
  });

  scenario("logs in upstream with MD5 as well as SCRAM", async (cx) => {
    await cx.seed(allowAll("md5"));
    const gw = await cx.startGateway(GATEWAY);
    const result = await psql(
      gw.port,
      `${cx.ids.workspace}-conn-0`,
      cx.ids.agentToken,
      ["SELECT current_user"],
    );
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(TARGET_ROLES.md5.username);
  });

  scenario("a cancel request stops the running query", async (cx) => {
    await cx.seed(allowAll());
    const gw = await cx.startGateway(GATEWAY);
    // psql sends a CancelRequest on SIGINT, carrying the gateway-issued key;
    // the gateway forwards it with the server's real key. The shell in the
    // container interrupts psql after a second, while the query sleeps.
    const result = await psqlShell(
      gw.port,
      `${cx.ids.workspace}-conn-0`,
      cx.ids.agentToken,
      'psql "$CONNINFO" -X -At -c "SELECT pg_sleep(30)" & sleep 1; kill -INT $!; wait $!',
    );
    expect(result.stderr).toContain("canceling statement due to user request");
  });

  scenario("logins fail with a reason the client shows", async (cx) => {
    await cx.seed(readsOnly());
    const gw = await cx.startGateway(GATEWAY);
    const user = `${cx.ids.workspace}-conn-0`;

    const badToken = await psql(gw.port, user, "aoc_not-a-token", ["SELECT 1"]);
    expect(badToken.stderr).toContain("token was not accepted");

    const unknown = await psql(gw.port, "conn_nope", cx.ids.agentToken, [
      "SELECT 1",
    ]);
    expect(unknown.stderr).toContain("no access to a database connection");

    const wrongDb = await psql(gw.port, user, cx.ids.agentToken, ["SELECT 1"], {
      database: "other",
    });
    expect(wrongDb.stderr).toContain('reaches the database "postgres"');

    const plaintext = await psql(
      gw.port,
      user,
      cx.ids.agentToken,
      ["SELECT 1"],
      { sslmode: "disable" },
    );
    expect(plaintext.stderr).toContain("over TLS only");

    const direct = await psql(
      gw.port,
      user,
      cx.ids.agentToken,
      ["SELECT 'direct'"],
      { sslmode: "require sslnegotiation=direct" },
    );
    expect(direct.stdout.trim()).toBe("direct");
  });

  /**
   * A portal runs its statement in parts, and SQL `FETCH` can run more of a
   * portal the protocol bound. So a `Bind` is judged by what its statement
   * runs: a write bound under a reads-only policy is refused at the `Bind`,
   * and nothing deletes even if the agent tries to fetch it.
   */
  scenario("binding a portal is judged by what it runs", async (cx) => {
    await cx.seed(readsOnly());
    const gw = await cx.startGateway(GATEWAY);
    const session = await openWireSession({
      port: gw.port,
      user: `${cx.ids.workspace}-conn-0`,
      token: cx.ids.agentToken,
    });
    try {
      expect((await session.batch(message.query("BEGIN"))).status).toBe("T");
      const bound = await session.batch(
        message.parse("del", `DELETE FROM ${TARGET_TABLE} RETURNING id`),
        message.bind("c", "del"),
        message.sync(),
      );
      expect(bound.errors[0]?.message).toContain(
        "OneCLI blocked this write statement",
      );
      expect(bound.status).toBe("T");
      const fetched = await session.batch(message.query("FETCH ALL FROM c"));
      expect(fetched.errors[0]?.code).toBe("34000"); // no such cursor
      await session.batch(message.query("ROLLBACK"));
    } finally {
      session.close();
    }
  });

  /**
   * The server refuses to prepare a name that is taken, and keys names by
   * their first 63 bytes. The gateway must read both the way the server
   * does, or a name would run one statement while judged as another.
   */
  scenario(
    "a prepared name keeps what the server holds, not what was refused",
    async (cx) => {
      await cx.seed(readsOnly());
      const gw = await cx.startGateway(GATEWAY);
      const session = await openWireSession({
        port: gw.port,
        user: `${cx.ids.workspace}-conn-0`,
        token: cx.ids.agentToken,
      });
      try {
        // Prepared (preparing runs nothing), then a refused re-prepare.
        await session.batch(
          message.query(`PREPARE s AS DELETE FROM ${TARGET_TABLE}`),
        );
        const taken = await session.batch(
          message.parse("s", "SELECT 1"),
          message.sync(),
        );
        expect(taken.errors[0]?.code).toBe("42P05");
        const run = await session.batch(message.query("EXECUTE s"));
        expect(run.errors[0]?.message).toContain(
          "OneCLI blocked this write statement",
        );

        // Two names sharing their first 63 bytes are one statement.
        const stem = "x".repeat(63);
        await session.batch(
          message.parse(`${stem}A`, `DELETE FROM ${TARGET_TABLE}`),
          message.sync(),
        );
        const alias = await session.batch(
          message.bind("", `${stem}B`),
          message.execute(""),
          message.sync(),
        );
        expect(alias.errors[0]?.message).toContain(
          "OneCLI blocked this write statement",
        );
      } finally {
        session.close();
      }
    },
  );

  /**
   * A startup packet's parameters apply before the first statement, so they
   * keep the guards a `SET` keeps: a `search_path` that puts a schema ahead
   * of `pg_catalog` (where a function could shadow a built-in the gateway
   * trusts as a read) is refused at login.
   */
  scenario("startup parameters keep the setting guards", async (cx) => {
    await cx.seed(allowAll());
    const gw = await cx.startGateway(GATEWAY);
    const login = (searchPath: string) =>
      openWireSession({
        port: gw.port,
        user: `${cx.ids.workspace}-conn-0`,
        token: cx.ids.agentToken,
        parameters: { search_path: searchPath },
      });
    await expect(login("evil, pg_catalog")).rejects.toThrow(
      "puts a schema ahead of pg_catalog",
    );
    const ok = await login("public");
    try {
      const shown = await ok.batch(message.query("SHOW search_path"));
      expect(shown.rows).toEqual([["public"]]);
    } finally {
      ok.close();
    }
  });

  /**
   * A pipelining driver ends a batch with `Flush` and keeps sending while
   * the server answers. The gateway relays those answers between units, and
   * must not lose the half-read next unit while it does.
   */
  scenario("a pipeline ended by Flush loses no message", async (cx) => {
    await cx.seed(allowAll());
    const gw = await cx.startGateway(GATEWAY);
    const session = await openWireSession({
      port: gw.port,
      user: `${cx.ids.workspace}-conn-0`,
      token: cx.ids.agentToken,
    });
    try {
      session.send(
        message.parse("", "SELECT pg_sleep(0.2), 1"),
        message.bind("", ""),
        message.execute(""),
        message.flush(),
        message.parse("two", "SELECT 2"),
        message.bind("", "two"),
      );
      // The answers to the Flush arrive while the next unit is half sent.
      await new Promise((resolve) => setTimeout(resolve, 600));
      session.send(message.execute(""), message.sync());
      const answered = await session.untilReady();
      expect(answered.errors).toEqual([]);
      expect(answered.rows.map((row) => row.at(-1))).toEqual(["1", "2"]);
    } finally {
      session.close();
    }
  });

  /**
   * The planted negative controls. A connection is reached only by an agent
   * whose grants select it: another agent in the same workspace, holding a
   * valid token but no grant, is refused; and a connection id from another
   * workspace reads exactly like one that does not exist.
   */
  scenario(
    "a connection is reached only by the agents granted it",
    async (cx) => {
      await cx.seed({
        ...allowAll(),
        rules: [
          ...allowAll().rules,
          // Seeds the second agent; its rule names no connection.
          {
            name: "other-agent-exists",
            action: "allow" as const,
            identities: ["other-agent" as const],
            targets: [{ hostPattern: "example.com" }],
          },
        ],
      });
      // A tenant of its own, with a PostgreSQL connection of its own.
      const foreign = {
        org: `${cx.ids.nonce}-foreign-org`,
        workspace: `${cx.ids.nonce}-foreign-ws`,
        connection: `${cx.ids.nonce}-foreign-conn`,
      };
      await cx.db.prisma.organization.create({
        data: { id: foreign.org, name: foreign.org, slug: foreign.org },
      });
      await cx.db.prisma.workspace.create({
        data: {
          id: foreign.workspace,
          name: foreign.workspace,
          organizationId: foreign.org,
        },
      });
      await cx.db.prisma.appConnection.create({
        data: {
          id: foreign.connection,
          provider: "postgres",
          scope: "workspace",
          workspaceId: foreign.workspace,
          organizationId: foreign.org,
          status: "connected",
        },
      });
      const gw = await cx.startGateway(GATEWAY);
      const user = `${cx.ids.workspace}-conn-0`;

      const otherAgent = await psql(
        gw.port,
        user,
        `${cx.ids.agentToken}-other`,
        ["SELECT 1"],
      );
      expect(otherAgent.stderr).toContain(
        `no access to a database connection with id "${user}"`,
      );

      // Another tenant's connection reads exactly like one that never was.
      const refusal = async (connectionId: string) =>
        (
          await psql(gw.port, connectionId, cx.ids.agentToken, ["SELECT 1"])
        ).stderr.replace(connectionId, "<id>");
      const elsewhere = await refusal(foreign.connection);
      expect(elsewhere).toContain("no access to a database connection");
      expect(elsewhere).toBe(await refusal(`${cx.ids.nonce}-never-existed`));

      // The granted agent still gets in.
      const granted = await psql(gw.port, user, cx.ids.agentToken, [
        "SELECT 'granted'",
      ]);
      expect(granted.stdout.trim()).toBe("granted");
    },
  );

  /**
   * A restarting gateway tells its idle database sessions why they end, in
   * the protocol's own terms, so a pool reconnects instead of reporting a
   * dropped connection.
   */
  scenario(
    "a restart ends idle sessions with a reconnect notice",
    async (cx) => {
      await cx.seed(allowAll());
      const gw = await cx.startGateway(GATEWAY);
      const session = await openWireSession({
        port: gw.port,
        user: `${cx.ids.workspace}-conn-0`,
        token: cx.ids.agentToken,
      });
      try {
        const goodbye = session.next();
        const exited = gw.terminate({ signal: "SIGTERM" });
        const message = await goodbye;
        expect(message.tag).toBe("E");
        expect(errorOf(message.body)).toMatchObject({
          severity: "FATAL",
          code: "57P01",
        });
        expect((await exited).code).toBe(0);
      } finally {
        session.close();
      }
    },
  );

  /**
   * Grants are re-read for every unit, so switching a connection off for an
   * agent ends the sessions it already holds, as it ends its HTTP access.
   */
  scenario("a revoked grant ends an open session", async (cx) => {
    await cx.seed({ ...allowAll(), withApiKey: true });
    const gw = await cx.startGateway(GATEWAY);
    const session = await openWireSession({
      port: gw.port,
      user: `${cx.ids.workspace}-conn-0`,
      token: cx.ids.agentToken,
    });
    try {
      const before = await session.batch(message.query("SELECT 1"));
      expect(before.rows).toEqual([["1"]]);

      await cx.db.prisma.policyRuleV2.deleteMany({
        where: { workspaceId: cx.ids.workspace, source: "grant" },
      });
      const invalidated = await fetch(`${gw.origin}/v1/cache/invalidate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cx.ids.apiKey}`,
          "content-type": "application/json",
        },
      });
      expect(invalidated.status).toBe(200);

      session.send(message.query("SELECT 2"));
      const goodbye = await session.next();
      expect(goodbye.tag).toBe("E");
      expect(errorOf(goodbye.body)).toMatchObject({
        severity: "FATAL",
        code: "28000",
      });
      expect(errorOf(goodbye.body).message).toContain(
        "no access to a database connection",
      );
    } finally {
      session.close();
    }
  });
});
