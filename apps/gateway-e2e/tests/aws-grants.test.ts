import { describe, expect } from "vitest";

import { throughProxy } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

/**
 * AWS per-tool grants at the WIRE, through the real binary.
 *
 * Scope, deliberately: **refusal paths only.** A refused request is answered by
 * the gateway and never leaves the host, so these scenarios can name real AWS
 * hostnames safely. The admission side is NOT tested here — proving "the grant
 * admits `s3.amazonaws.com`" over the wire would mean actually forwarding to
 * AWS, and a test suite must not depend on (or generate) real egress. Admission
 * is pinned exhaustively at the matcher layer instead, on both ports and from
 * one shared table of endpoint shapes observed from live SDK traffic:
 * `packages/api/src/apps/app-permissions/aws-endpoint-coverage.test.ts` and
 * `catalog.rs::aws_tool_rules_cover_real_endpoint_shapes`.
 *
 * What this file adds that those cannot: the security-critical NEGATIVES
 * surviving the whole request path — proxy → policy engine → response — rather
 * than the matcher in isolation. AWS is a multi-host-family app, so a tool rule
 * must never fold into the shared `*.amazonaws.com` credential zone; these are
 * the two ways that could go wrong.
 */
describe("aws per-tool grants (wire-level refusals)", () => {
  /**
   * The real grant stack `compileConnectionStack` emits for "custom access,
   * only s3_read_objects": the allow row, then the TERMINAL block over the
   * whole app. The terminal row is what makes the stack deny-by-default, and
   * it is the rule that named itself in the field report
   * ("Grant: … · …: everything else"). Reproducing both rows is the point —
   * an allow row alone would leave unmatched requests to fall through to the
   * gateway's default, which is not what production does.
   */
  const s3ReadGrantStack = [
    {
      name: "Grant: e2e · aws-role: allowed",
      action: "allow",
      identities: ["agent"],
      targets: [
        {
          kind: "connection",
          connectionIndex: 0,
          tools: ["s3_read_objects"],
        },
      ],
    },
    {
      name: "Grant: e2e · aws-role: everything else",
      action: "block",
      identities: ["agent"],
      targets: [{ kind: "connection", connectionIndex: 0 }],
    },
  ] as const;

  scenario(
    "an S3 grant does not reach the separate s3tables service",
    async (cx) => {
      // `s3tables` is its own AWS service with its own IAM actions, and is
      // exactly what a tempting `s3*.amazonaws.com` glob would have swallowed.
      // Nothing else names this host, so the refusal can only come from the
      // grant stack's terminal block.
      await cx.seed({
        appConnections: [{ provider: "aws-role" }],
        rules: [...s3ReadGrantStack],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: "http://s3tables.us-east-1.amazonaws.com/buckets",
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
    },
  );

  scenario(
    "an S3 grant does not carry across to a sibling AWS service",
    async (cx) => {
      // The credential is injected across the whole `*.amazonaws.com` zone, so
      // "granted the account" must not mean "granted every service on it".
      await cx.seed({
        appConnections: [{ provider: "aws-role" }],
        rules: [...s3ReadGrantStack],
      });
      const gw = await cx.startGateway();

      const res = await throughProxy(gw.origin, {
        url: "http://iam.amazonaws.com/?Action=ListRoles",
        token: cx.ids.agentToken,
      });

      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: "blocked_by_policy" });
    },
  );

  scenario(
    "a look-alike registrable domain receives no AWS credential",
    async (cx) => {
      // `s3.us-east-1.amazonaws.com.evil.test` ends with an attacker-registrable
      // suffix. The assertion is about CREDENTIAL REACH, not the status code:
      // the host is outside the provider's injection zone, so neither grant row
      // matches and the request is forwarded UNCREDENTIALED (it then fails to
      // resolve). Blocking arbitrary egress is a separate control — the
      // deny-default carve keys on "injected + non-LLM" — so what this pins is
      // the property that matters here: an AWS grant never splices an AWS
      // credential onto a look-alike domain.
      await cx.seed({
        appConnections: [{ provider: "aws-role" }],
        rules: [...s3ReadGrantStack],
      });
      const gw = await cx.startGateway();

      await expect(
        throughProxy(gw.origin, {
          url: "http://s3.us-east-1.amazonaws.com.evil.test/key",
          token: cx.ids.agentToken,
        }),
      ).rejects.toThrow();

      // The proof: the gateway logged the attempt with no injection. Wait for
      // the line rather than reading `logs()` straight away — the request
      // rejects on DNS, which can outrun the log flush.
      await gw.waitForLog("HTTP_PROXY");
      const logs = gw.logs();
      expect(logs).toContain("s3.us-east-1.amazonaws.com.evil.test");
      expect(logs).toMatch(/"injection_count":0/);
    },
  );
});
