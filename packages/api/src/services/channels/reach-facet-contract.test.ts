import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { slackReach } from "./providers/slack/reach-card";
import type { ChannelProvider } from "./types";

/**
 * THE GENERICITY CONTRACT — the user's explicit requirement: "generic enough
 * so we could reuse it for other channels in the future."
 *
 * Slack is the only registered provider, so "provider-generic" is otherwise
 * an untested claim: every other reach test exercises the Slack facet, and a
 * Slack-shaped assumption baked into the FACET would look identical to a
 * correct design until the day someone implements Teams.
 *
 * This suite is that missing check. It implements the reach facet for a
 * fictional provider with deliberately un-Slack-like shapes — no `#`
 * channels, no `C…`/`U…` ids, a different address separator, and no notion
 * of a "workspace member". It type-checks against the facet interface, which
 * is the whole proof: the facet is implementable without Slack concepts.
 *
 * What it can prove: the facet is implementable without Slack concepts, its
 * kinds compose, and the pieces the generic service consumes (space key,
 * labels, tenant verdict, card payloads) are all provider-owned strings.
 *
 * What it cannot prove (stated so nobody over-reads it): the registry's id
 * union is closed to `"slack"`, so a second provider cannot be REGISTERED
 * here; the end-to-end lane still runs on Slack. This is a shape contract,
 * not a second live integration.
 *
 * It also pins BOTH SIDES. A fake alone would only prove that something
 * satisfies the interface - written to fit, it could drift from what the
 * real provider does. `slackReach` is declared without a type annotation
 * (its shape is inferred, and only checked where the provider object is
 * assembled), so the arm below pins the real facet to the same interface as
 * the fictional one. If the interface grew a method Slack does not
 * implement, that arm stops type-checking.
 */

/** A fictional provider: threads addressed "room@42/thread@7", numeric ids,
 *  people addressed as "person@N", tenants as opaque org handles. */
type Facet = NonNullable<ChannelProvider["reach"]>;

const teamsish: Facet = {
  spaceOf: (externalThreadId) => externalThreadId.split("/")[0] ?? "",
  spaceThreadPrefix: (externalRef) => `${externalRef}/`,

  async spaceLabel({ credentialsJson, externalRef }) {
    if (!credentialsJson) return null;
    return `Room ${externalRef.replace("room@", "")}`;
  },

  async personLabel({ credentialsJson, externalRef }) {
    if (!credentialsJson) return null;
    return `Person ${externalRef.replace("person@", "")}`;
  },

  // This provider has no app concept: a room's app roster is always empty.
  async appsIn() {
    return [];
  },

  async resolveGuestSpeaker({
    credentialsJson,
    externalUserId,
    tenantExternalId,
  }) {
    if (!credentialsJson) return null;
    // This provider carries the tenant inside the address itself - a shape
    // Slack does not have, and the generic service must not care.
    const [, tenant] = externalUserId.split("#");
    return {
      displayName: `User ${externalUserId.split("#")[0]}`,
      sameTenant: tenant === tenantExternalId,
      isApp: false,
    };
  },

  async verifySubject({
    credentialsJson,
    subjectKind,
    externalRef,
    tenantExternalId,
  }) {
    // Fail-open without a credential, per the type's contract.
    if (!credentialsJson) return { ok: true };
    if (subjectKind === "external_user") {
      const [, tenant] = externalRef.split("#");
      return tenant === tenantExternalId
        ? { ok: true }
        : { ok: false, reason: "person left the org" };
    }
    // This provider marks dead rooms with a trailing "!".
    return externalRef.endsWith("!")
      ? { ok: false, reason: "room is gone" }
      : { ok: true };
  },

  async spaceMembership({ credentialsJson, externalRef }) {
    // No credential = cannot tell; the reconciler changes nothing.
    if (!credentialsJson) return { kind: "unknown" };
    return { kind: externalRef.endsWith("!") ? "gone" : "member" };
  },

  card: {
    async post({ grantId, subjectKind, agentName, subjectLabel }) {
      return {
        channel: `dm:${subjectKind}:${grantId}`,
        ts: `${agentName}|${subjectLabel}`,
      };
    },
    async settle() {
      /* a provider with no edit API may legitimately do nothing */
    },
  },
};

describe("the reach facet is provider-generic (contract, not Slack)", () => {
  it("the REAL Slack facet and the fictional one satisfy the SAME contract", () => {
    // A compile-time contract (tsc runs over test files in CI): both sides
    // are pinned to the interface. Without the real side the suite would
    // only prove a purpose-built fake fits, which is circular. Runtime
    // assertions on the fake's own return values could never fail, so the
    // proof lives in the types.
    expectTypeOf(slackReach).toMatchTypeOf<Facet>();
    expectTypeOf(teamsish).toEqualTypeOf<Facet>();
  });
});

/**
 * A SOURCE PIN for the test-suite rule that CI taught us twice.
 *
 * `sweepUnpostedReachCards` is global by contract - a background retry, not
 * a per-agent call - and the pg suites share one database in parallel. A
 * test that calls it unfenced posts OTHER suites' owner cards and claims
 * their cardRefs, which surfaces as a sibling suite failing an assertion
 * it owns. That is a nightmare to diagnose from a CI log, and it happened
 * twice on this branch: the first fix fenced the one call site I had
 * added, and the four older ones kept doing it.
 *
 * The fix was one `sweepFencedTo` helper. This pin keeps it that way: it
 * fails if a future test reintroduces a direct call, instead of letting
 * the mistake reappear as an intermittent red on someone else's PR.
 *
 * Same posture as the `public-origins.ts` source pin - the cheapest way to
 * enforce a rule that types cannot express.
 */
describe("pg suite rule: the global card sweep is only ever called fenced", () => {
  it("agent-reach.pg.test.ts calls sweepUnpostedReachCards exactly once, inside the helper", () => {
    const source = readFileSync(
      join(__dirname, "agent-reach.pg.test.ts"),
      "utf8",
    );
    // Count real CALLS, not the mentions in comments.
    const calls = source.match(/await reach\.sweepUnpostedReachCards\(\)/g);
    expect(calls).toHaveLength(1);
    // ...and that one call is the helper's body.
    const helperStart = source.indexOf("const sweepFencedTo");
    const helperEnd = source.indexOf("const settleDetached");
    const callAt = source.indexOf("await reach.sweepUnpostedReachCards()");
    expect(helperStart).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(helperStart);
    expect(callAt).toBeLessThan(helperEnd);
  });
});
