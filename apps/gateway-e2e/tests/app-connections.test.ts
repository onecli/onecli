import { describe, expect } from "vitest";

import { throughMitm } from "../src/mitm.js";
import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * The secret-vs-OAuth coexistence law (#722).
 *
 * Before it, app-connection resolution was skipped whenever the host had any
 * secret rules, so one vaulted API key on a shared Google host silently
 * suppressed OAuth injection for every other app on that host. The fix lets the
 * two coexist, and swallows an app-side ambiguity escalation when the secret
 * rules already serve the requested path.
 *
 * Two connections for one provider is the cheapest way to make that escalation
 * observable: it is decided purely by grouping on provider and id, before any
 * credential is decrypted and before any socket is opened — so the whole test
 * is hermetic even though the hostname is a real provider's.
 */
const GMAIL_HOST = "gmail.googleapis.com";

const AMBIGUOUS_WORLD = {
  // Grants put both accounts + the secret in the injection pool (step 7:
  // nothing is eligible without one); the block rules below sit at spec
  // priorities and keep first-match over the tail-band grant allows.
  grantAll: true,
  appConnections: [{ provider: "gmail" }, { provider: "gmail" }],
  secrets: [
    {
      hostPattern: GMAIL_HOST,
      pathPattern: "/gmail/*",
      headerName: "x-test-key",
      value: "sk-e2e-shared-host",
    },
  ],
  // Guarantees the swallowed branch still cannot egress: once the ambiguity is
  // swallowed the request proceeds to the policy engine, which refuses it.
  rules: [
    {
      name: "block-gmail",
      action: "block" as const,
      targets: [{ hostPattern: GMAIL_HOST }],
    },
  ],
};

describe("app connection resolution", () => {
  scenario("swallows ambiguity when a secret serves the path", async (cx) => {
    await cx.seed(AMBIGUOUS_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `http://${GMAIL_HOST}/gmail/v1/users/me`,
      token: cx.ids.agentToken,
    });

    // `/gmail/*` covers this path, so the two ambiguous connections stop being
    // an error and the request continues on the secret's rules alone —
    // reaching the policy engine, which blocks it. Before #722 this was a 409.
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-gmail",
    });

    // Forwarded (non-escalation) responses advertise the account choices via
    // `x-onecli-connections` — including this policy 403, which is produced by
    // the forward path. The 409s below deliberately do NOT carry it (they
    // return before the header-injection point); the self-describing body is
    // their discovery surface.
    const advertised = res.header("x-onecli-connections");
    expect(advertised).toBeTruthy();
    const choices = JSON.parse(advertised ?? "[]") as Array<{ id: string }>;
    expect(choices.map((c) => c.id).sort()).toEqual([
      `${cx.ids.workspace}-conn-0`,
      `${cx.ids.workspace}-conn-1`,
    ]);
  });

  scenario("still escalates ambiguity off the secret's path", async (cx) => {
    await cx.seed(AMBIGUOUS_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `http://${GMAIL_HOST}/other/v1/thing`,
      token: cx.ids.agentToken,
    });

    // Same world, one path segment different. Here no secret rule serves the
    // request, so the ambiguity is a genuine dead end and the agent is told how
    // to resolve it — ahead of the policy engine, hence 409 and not the 403
    // above. This pair is the whole of #722's behavior change.
    expect(res.status).toBe(409);
    expect(res.header("x-should-retry")).toBe("false");
    const body = res.json() as {
      error: string;
      header: string;
      example: string;
      connections: Array<{ id: string; provider: string }>;
    };
    expect(body).toMatchObject({
      error: "multiple_connections",
      header: "x-onecli-connection-id",
    });
    // The body is the protocol's whole discovery surface (no CLI/SDK helper
    // exists): it must carry every valid choice and a copy-pasteable example.
    expect(body.connections.map((c) => c.id).sort()).toEqual([
      `${cx.ids.workspace}-conn-0`,
      `${cx.ids.workspace}-conn-1`,
    ]);
    expect(body.connections.every((c) => c.provider === "gmail")).toBe(true);
    expect(body.example).toContain("x-onecli-connection-id");
  });

  scenario("rejects an unknown connection id", async (cx) => {
    await cx.seed(AMBIGUOUS_WORLD);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `http://${GMAIL_HOST}/other/v1/thing`,
      token: cx.ids.agentToken,
      headers: { "x-onecli-connection-id": "no-such-connection" },
    });

    // An explicit override that names nothing is an error rather than a silent
    // fallback to the ambiguous set.
    expect(res.status).toBe(404);
    expect(res.json()).toMatchObject({ error: "connection_not_found" });
  });

  scenario("binds decisions to the winning connection", async (cx) => {
    // The per-connection differential, end to end through the real binary: a
    // block naming ONLY connection 0, plus a differently-named backstop block
    // (so the sibling direction still cannot egress a real provider host).
    // The SAME request either dies on the per-connection rule or sails past it
    // to the backstop, decided purely by which account the header picks — two
    // different rule_names prove per-account matching without leaving the
    // machine.
    await cx.seed({
      grantAll: true,
      appConnections: [{ provider: "gmail" }, { provider: "gmail" }],
      rules: [
        {
          name: "block-work-gmail",
          action: "block" as const,
          targets: [{ kind: "connection" as const, connectionIndex: 0 }],
        },
        {
          name: "backstop-block-gmail",
          action: "block" as const,
          targets: [{ hostPattern: GMAIL_HOST }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const send = (connectionId: string) =>
      throughProxy(gw.origin, {
        url: `http://${GMAIL_HOST}/gmail/v1/users/me/messages`,
        token: cx.ids.agentToken,
        headers: { "x-onecli-connection-id": connectionId },
      });

    // Via connection 0 the per-connection block decides…
    const viaWork = await send(`${cx.ids.workspace}-conn-0`);
    expect(viaWork.status).toBe(403);
    expect(viaWork.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-work-gmail",
    });

    // …via the same-provider sibling it does NOT bind — the backstop decides.
    const viaPersonal = await send(`${cx.ids.workspace}-conn-1`);
    expect(viaPersonal.status).toBe(403);
    expect(viaPersonal.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "backstop-block-gmail",
    });
  });

  scenario("records a host-gated mismatch with the bound host", async (cx) => {
    // The #1137 shape through the real binary: a granted JFrog connection
    // bound to one tenant host, a request to a sibling host under the same
    // gated suffix. The gate refuses injection BEFORE any socket is opened
    // (the token stays with acme), and what changed is that it now says so:
    // the mismatch is recorded with the bound host, at info level, where
    // production used to log nothing at all.
    //
    // Hermetic by construction: a block rule on the host stops the request at
    // the policy engine, so no DNS lookup or upstream connection is ever
    // attempted — the resolution (where the gate runs) still happens first.
    const WRONG_HOST = "other-tenant.jfrog.io";
    await cx.seed({
      grantAll: true,
      appConnections: [
        {
          provider: "jfrog-artifactory",
          label: "Acme Artifactory",
          credentials: {
            access_token: "e2e-jfrog-token",
            subdomain: "acme.jfrog.io",
          },
        },
      ],
      rules: [
        {
          name: "block-wrong-tenant",
          action: "block" as const,
          targets: [{ hostPattern: WRONG_HOST }],
        },
      ],
    });
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `http://${WRONG_HOST}/artifactory/api/npm/npm/lodash`,
      token: cx.ids.agentToken,
    });

    // The block decides the response (the mismatch is a soft signal, never a
    // pre-forward refusal of its own) …
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({
      error: "blocked_by_policy",
      rule_name: "block-wrong-tenant",
    });

    // … and the gate's refusal is now visible, naming both hosts. Before this
    // fix the line was debug-level and absent from production logs.
    await gw.waitForLog("credential host mismatch");
    const line = gw
      .logs()
      .split("\n")
      .find((l) => l.includes("credential host mismatch"));
    expect(line).toBeDefined();
    expect(line).toContain(`"requested_host":"${WRONG_HOST}"`);
    expect(line).toContain('"bound_host":"acme.jfrog.io"');
    expect(line).toContain('"provider":"jfrog-artifactory"');
  });

  // The #1137 incident, replayed verbatim through the real binary: a granted
  // Salesforce connection bound to one org, and the agent's request going to
  // the docs' placeholder hostname. That host is NXDOMAIN (it was in
  // production and it is here: `.my.salesforce.com` labels are per-tenant and
  // `your-domain` is nobody's), so the request dies at DNS exactly as it did
  // on 2026-09-23 — and the response is what changed. Before: an opaque
  // `502 resolution_failed`. After: a 421 that names the bound host and the
  // exact URL to re-send to.
  //
  // Both proxy paths, because the gateway has two: the CONNECT tunnel (what
  // the production agent used) and absolute-form HTTP.
  const SALESFORCE_1137 = {
    grantAll: true,
    appConnections: [
      {
        provider: "salesforce",
        label: "jane@acme.example",
        credentials: {
          access_token: "e2e-sf-token",
          refresh_token: "e2e-sf-refresh",
          token_type: "Bearer",
          // Far-future expiry so the gateway never tries a refresh.
          expires_at: 4_102_444_800,
          instance_host: "acme.my.salesforce.com",
          token_endpoint: "https://login.salesforce.com/services/oauth2/token",
        },
      },
    ],
  };
  const PLACEHOLDER_HOST = "your-domain.my.salesforce.com";
  const INCIDENT_PATH = "/services/data/v59.0/sobjects/Opportunity";

  const expectIncidentExplained = (res: {
    status: number;
    header(name: string): string | undefined;
    json(): unknown;
  }) => {
    expect(res.status).toBe(421);
    expect(res.header("x-should-retry")).toBe("false");
    const body = res.json() as {
      error: string;
      requested_host: string;
      provider: string;
      message: string;
      connections: Array<{ label: string; host?: string }>;
    };
    expect(body.error).toBe("connection_host_mismatch");
    expect(body.requested_host).toBe(PLACEHOLDER_HOST);
    expect(body.provider).toBe("salesforce");
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.host).toBe("acme.my.salesforce.com");
    expect(body.connections[0]?.label).toBe("jane@acme.example");
    // The fix must be a copy-paste: the same path on the bound host.
    expect(body.message).toContain(
      `https://acme.my.salesforce.com${INCIDENT_PATH}`,
    );
    // And no credential material anywhere in the explanation.
    expect(JSON.stringify(body)).not.toContain("e2e-sf-");
  };

  scenario("replays #1137 through the CONNECT tunnel", async (cx) => {
    await cx.seed(SALESFORCE_1137);
    const gw = await cx.startGateway();

    const res = await throughMitm(gw.origin, {
      authority: `${PLACEHOLDER_HOST}:443`,
      path: INCIDENT_PATH,
      token: cx.ids.agentToken,
      caPath: gw.caPath,
    });

    expectIncidentExplained(res);
  });

  scenario("replays #1137 through absolute-form HTTP", async (cx) => {
    await cx.seed(SALESFORCE_1137);
    const gw = await cx.startGateway();

    const res = await throughProxy(gw.origin, {
      url: `https://${PLACEHOLDER_HOST}${INCIDENT_PATH}`,
      token: cx.ids.agentToken,
    });

    expectIncidentExplained(res);
  });

  // The Snowflake incident (2026-09-28), replayed through the real binary: a
  // granted Snowflake connection bound to one account, and the agent calling
  // Snowflake's generic `api.snowflake.com` — which does not resolve. Before:
  // `502 resolution_failed`, and the agent told the user Snowflake was not
  // connected. After: a 421 naming the account host, read from the
  // connection's non-secret `metadata.bound_host` (an alias host never
  // decrypts or injects the credential).
  scenario(
    "answers Snowflake's generic API host with the bound account host",
    async (cx) => {
      await cx.seed({
        grantAll: true,
        appConnections: [
          {
            provider: "snowflake",
            label: "acme-prod",
            credentials: {
              access_token: "e2e-snow-pat",
              host: "acme-prod.snowflakecomputing.com",
            },
            metadata: { bound_host: "acme-prod.snowflakecomputing.com" },
          },
        ],
      });
      const gw = await cx.startGateway();

      const res = await throughMitm(gw.origin, {
        authority: "api.snowflake.com:443",
        path: "/api/v2/statements",
        token: cx.ids.agentToken,
        caPath: gw.caPath,
      });

      expect(res.status).toBe(421);
      const body = res.json() as {
        error: string;
        provider: string;
        message: string;
        connections: Array<{ host?: string }>;
      };
      expect(body.error).toBe("connection_host_mismatch");
      expect(body.provider).toBe("snowflake");
      expect(body.connections[0]?.host).toBe(
        "acme-prod.snowflakecomputing.com",
      );
      expect(body.message).toContain(
        "https://acme-prod.snowflakecomputing.com/api/v2/statements",
      );
      expect(JSON.stringify(body)).not.toContain("e2e-snow-");

      // And it reaches the activity feed. Before #1158 this failure was
      // visible only in server logs: an un-injected answer was logged as a
      // plain allow and dropped. Terminating runs the final telemetry flush,
      // so the row is in Postgres when the process exits.
      expect((await gw.terminate()).code).toBe(0);
      const rows = await cx.db.prisma.requestLog.findMany({
        where: { host: { startsWith: "api.snowflake.com" } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 421,
        path: "/api/v2/statements",
        provider: "snowflake",
        injectionCount: 0,
      });
      expect(rows[0]?.extraData).toMatchObject({
        decision: "needs_connection",
        guidance_error: "connection_host_mismatch",
      });
    },
  );
});
