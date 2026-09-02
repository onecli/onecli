import { describe, it, expect } from "vitest";
import { createDoor } from "./create-door";
import type { HostedAvailability } from "./availability";

const byo = { kind: "byo" as const };
const hosted = { kind: "hosted" as const };

// The self-host / fallback arm: no org world in play.
const open = { orgByoLegacy: null, orgByoEnabled: null };

describe("createDoor (self-host / org world unknown — the workspace-derived arm)", () => {
  it("gives a brand-new user the hosted door alone", () => {
    // The whole point: someone who has never made an agent never meets the
    // word "BYO".
    expect(createDoor({ agents: [], availability: "ready", ...open })).toBe(
      "hosted",
    );
  });

  it("keeps a legacy user's primary action on BYO, hosted in the chevron", () => {
    expect(createDoor({ agents: [byo], availability: "ready", ...open })).toBe(
      "byo-with-hosted",
    );
  });

  it("treats a hosted-only workspace as new — it is already in the new world", () => {
    expect(
      createDoor({ agents: [hosted], availability: "ready", ...open }),
    ).toBe("hosted");
  });

  it("sees one legacy agent among hosted ones and keeps the split door", () => {
    expect(
      createDoor({
        agents: [hosted, hosted, byo],
        availability: "ready",
        ...open,
      }),
    ).toBe("byo-with-hosted");
  });

  it("offers hosted while agents are OFFLINE — they exist, they are just down", () => {
    // Offline is a runtime state, not "the surface doesn't exist"; the dialog
    // itself explains the outage.
    expect(
      createDoor({ agents: [byo], availability: "offline", ...open }),
    ).toBe("byo-with-hosted");
    expect(createDoor({ agents: [], availability: "offline", ...open })).toBe(
      "hosted",
    );
  });

  it("falls back to BYO alone where no hosted surface exists", () => {
    // Byte-identical to today's page on a deployment with no runner.
    for (const agents of [[], [byo], [hosted]]) {
      expect(createDoor({ agents, availability: "absent", ...open })).toBe(
        "byo",
      );
    }
  });

  it("never flashes a door it might take away while loading", () => {
    // Agents unknown: show the flow that works in EVERY end state. Gaining a
    // chevron later is quiet; losing a button is not.
    const cases: [HostedAvailability, string][] = [
      ["loading", "byo"],
      ["absent", "byo"],
      ["ready", "byo-with-hosted"],
      ["offline", "byo-with-hosted"],
    ];
    for (const [availability, expected] of cases) {
      expect(createDoor({ agents: undefined, availability, ...open })).toBe(
        expected,
      );
    }
  });

  it("hides hosted while availability is still loading, even with agents known", () => {
    expect(createDoor({ agents: [], availability: "loading", ...open })).toBe(
      "byo",
    );
    expect(
      createDoor({ agents: [byo], availability: "loading", ...open }),
    ).toBe("byo");
  });
});

describe("createDoor (cloud — the org's creation world is authoritative)", () => {
  it("gives a hosted-world org the hosted door alone, whatever the workspace holds", () => {
    // §3.10 as re-decided 2026-08-23: byoLegacy=false means hosted-only
    // creation. Old BYO agents keep working; only the create door changes.
    for (const agents of [[], [byo], [hosted, byo], undefined]) {
      for (const availability of [
        "ready",
        "offline",
        "absent",
        "loading",
      ] as const) {
        expect(
          createDoor({
            agents,
            availability,
            orgByoLegacy: false,
            orgByoEnabled: false,
          }),
        ).toBe("hosted");
      }
    }
  });

  it("gives a MIXED-world org the hosted-primary split door in every state", () => {
    // byoLegacy=false + byoEnabled=true (2026-08-29): hosted stays primary,
    // BYO creation is one click away. Availability doesn't gate the chevron
    // — BYO needs no runner, and the hosted-world door already ignores
    // availability on cloud.
    for (const agents of [[], [byo], [hosted, byo], undefined]) {
      for (const availability of [
        "ready",
        "offline",
        "absent",
        "loading",
      ] as const) {
        expect(
          createDoor({
            agents,
            availability,
            orgByoLegacy: false,
            orgByoEnabled: true,
          }),
        ).toBe("hosted-with-byo");
      }
    }
  });

  it("never consults byoEnabled in a BYO-world org — byoLegacy wins", () => {
    for (const orgByoEnabled of [false, true, null]) {
      expect(
        createDoor({
          agents: [byo],
          availability: "ready",
          orgByoLegacy: true,
          orgByoEnabled,
        }),
      ).toBe("byo-with-hosted");
    }
  });

  it("gives a BYO-world org the split door even in a fresh workspace", () => {
    // The stamp, not the workspace's agents, is the fact — a BYO-world org's
    // new workspace must not be wrongly hosted-only.
    for (const agents of [[], [hosted], [byo], undefined]) {
      expect(
        createDoor({
          agents,
          availability: "ready",
          orgByoLegacy: true,
          orgByoEnabled: false,
        }),
      ).toBe("byo-with-hosted");
    }
  });

  it("drops a BYO-world org to the plain BYO door where no hosted surface exists", () => {
    for (const availability of ["absent", "loading"] as const) {
      expect(
        createDoor({
          agents: [byo],
          availability,
          orgByoLegacy: true,
          orgByoEnabled: false,
        }),
      ).toBe("byo");
    }
  });
});
