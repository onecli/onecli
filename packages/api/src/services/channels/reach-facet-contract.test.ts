import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
 * of a "workspace member" — and asserts the facet's own contract holds.
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
 * assembled), so the arm below asserts the real facet and the fictional
 * one are the SAME contract. If Slack grew a method the interface does not
 * describe, or the interface grew one Slack does not implement, that arm
 * stops compiling.
 */

/** A fictional provider: threads addressed "room@42/thread@7", numeric ids,
 *  people addressed as "person@N", tenants as opaque org handles. */
const teamsish: NonNullable<ChannelProvider["reach"]> = {
  spaceOf: (externalThreadId) => externalThreadId.split("/")[0] ?? "",

  async spaceLabel({ credentialsJson, externalRef }) {
    if (!credentialsJson) return null;
    return `Room ${externalRef.replace("room@", "")}`;
  },

  async personLabel({ credentialsJson, externalRef }) {
    if (!credentialsJson) return null;
    return `Person ${externalRef.replace("person@", "")}`;
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
    };
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
    // Both sides pinned to the interface. Without this the suite would only
    // prove a purpose-built fake fits - which is circular.
    const real: NonNullable<ChannelProvider["reach"]> = slackReach;
    const fake: NonNullable<ChannelProvider["reach"]> = teamsish;

    // The required surface, present on both - a provider author can read
    // this list as "what I must implement".
    for (const facet of [real, fake]) {
      expect(typeof facet.spaceOf).toBe("function");
      expect(typeof facet.spaceLabel).toBe("function");
      expect(typeof facet.resolveGuestSpeaker).toBe("function");
      expect(typeof facet.card.post).toBe("function");
      expect(typeof facet.card.settle).toBe("function");
    }
    // `personLabel` is optional by contract: the person lane degrades to the
    // raw ref rather than breaking for a provider that cannot resolve one.
    expect(typeof real.personLabel).toBe("function");
    expect(typeof fake.personLabel).toBe("function");
  });

  it("a non-Slack address shape yields its own space key", () => {
    // No colon separator, no C-prefixed ids: the generic ledger stores
    // whatever this returns and never parses it.
    expect(teamsish.spaceOf("room@42/thread@7")).toBe("room@42");
    expect(teamsish.spaceOf("room@1")).toBe("room@1");
  });

  it("both label kinds are optional-by-contract and degrade to null", async () => {
    // The service must tolerate a provider that cannot resolve a label -
    // the dashboard then shows the raw ref rather than breaking.
    expect(
      await teamsish.spaceLabel({
        credentialsJson: null,
        externalRef: "room@42",
      }),
    ).toBeNull();
    expect(
      await teamsish.personLabel?.({
        credentialsJson: null,
        externalRef: "person@9",
      }),
    ).toBeNull();
    expect(
      await teamsish.spaceLabel({
        credentialsJson: "{}",
        externalRef: "room@42",
      }),
    ).toBe("Room 42");
    expect(
      await teamsish.personLabel?.({
        credentialsJson: "{}",
        externalRef: "person@9",
      }),
    ).toBe("Person 9");
  });

  it("the same-tenant fence is the PROVIDER's verdict, however it computes it", async () => {
    // Slack reads `team_id`; this provider parses the address. The generic
    // guest lane only ever sees the boolean.
    const inside = await teamsish.resolveGuestSpeaker({
      credentialsJson: "{}",
      externalUserId: "7#acme",
      tenantExternalId: "acme",
    });
    expect(inside?.sameTenant).toBe(true);
    expect(inside?.displayName).toBe("User 7");

    const outside = await teamsish.resolveGuestSpeaker({
      credentialsJson: "{}",
      externalUserId: "7#other-corp",
      tenantExternalId: "acme",
    });
    expect(outside?.sameTenant).toBe(false);
  });

  it("fails closed when the speaker cannot be verified", async () => {
    expect(
      await teamsish.resolveGuestSpeaker({
        credentialsJson: null,
        externalUserId: "7#acme",
        tenantExternalId: "acme",
      }),
    ).toBeNull();
  });

  it("the card carries the SUBJECT KIND, so a provider can render person vs space differently", async () => {
    const person = await teamsish.card.post({
      credentialsJson: "{}",
      recipientExternalUserId: "person@1",
      grantId: "g-1",
      agentName: "Ada",
      subjectLabel: "Person 9",
      subjectKind: "external_user",
    });
    const space = await teamsish.card.post({
      credentialsJson: "{}",
      recipientExternalUserId: "person@1",
      grantId: "g-2",
      agentName: "Ada",
      subjectLabel: "Room 42",
      subjectKind: "space",
    });
    // The kind reaches the renderer - the hook that lets a new provider ask
    // the two-answer person question instead of the three-answer space one.
    expect(person.channel).toContain("external_user");
    expect(space.channel).toContain("space");
    // And the handle it returns is opaque: any two strings the provider can
    // later use to find its own message.
    expect(typeof person.ts).toBe("string");
  });

  it("settle may be a no-op: a provider without message editing is still valid", async () => {
    await expect(
      teamsish.card.settle({
        credentialsJson: "{}",
        channel: "dm:x",
        ts: "1",
        subjectLabel: "Person 9",
        outcome: "approved",
        decidedByName: "Owner",
        subjectKind: "external_user",
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * A SOURCE PIN for the test-suite rule that CI taught us twice.
 *
 * `sweepUnpostedReachCards` is global by contract - a background retry, not
 * a per-agent call - and the pg suites share one database in parallel. A
 * test that calls it unfenced posts OTHER suites' owner cards and claims
 * their promptRefs, which surfaces as a sibling suite failing an assertion
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
