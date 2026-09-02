import { describe, expect } from "vitest";

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
});
