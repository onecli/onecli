import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHeldAwakeOverride } from "../lib/env";
import { heldAwakeCeiling } from "./due-work";

/**
 * The held-awake ceiling's NUMBER (step 13): env override wins, otherwise
 * `max(1, maxSandboxes − 1)` derived from the runner's own capabilities.
 * The rules are proven on the pure functions; one re-import proves the
 * module-load env wiring. The eviction MECHANISM is proven on real
 * PostgreSQL in processes.pg.test.ts.
 */

const ORIGINAL = process.env.MAX_HELD_AWAKE_SANDBOXES;

vi.mock("@onecli/db", () => ({ db: {}, Prisma: {} }));

/** The full registration shape — the schema requires backend + durability. */
const caps = (maxSandboxes: number) => ({
  maxSandboxes,
  backend: "docker",
  homeDurability: "resident" as const,
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.MAX_HELD_AWAKE_SANDBOXES;
  } else {
    process.env.MAX_HELD_AWAKE_SANDBOXES = ORIGINAL;
  }
});

describe("heldAwakeCeiling", () => {
  it("derives max(1, maxSandboxes − 1) when there is no override", () => {
    expect(heldAwakeCeiling(caps(4), null)).toBe(3);
    expect(heldAwakeCeiling(caps(2), null)).toBe(1);
  });

  it("floors at 1 — a one-slot runner keeps keep-awake usable", () => {
    expect(heldAwakeCeiling(caps(1), null)).toBe(1);
  });

  it("treats unparseable capabilities as the conservative floor", () => {
    expect(heldAwakeCeiling(null, null)).toBe(1);
    expect(heldAwakeCeiling({ nonsense: true }, null)).toBe(1);
  });

  it("the operator override wins over the derived default", () => {
    expect(heldAwakeCeiling(caps(4), 7)).toBe(7);
  });
});

describe("parseHeldAwakeOverride", () => {
  it("accepts a positive integer", () => {
    expect(parseHeldAwakeOverride("7")).toBe(7);
  });

  it("an invalid value means derivation — never unlimited", () => {
    for (const bad of [undefined, "0", "-3", "x", "", "1.5"]) {
      expect(parseHeldAwakeOverride(bad)).toBeNull();
    }
  });
});

describe("heldAwakeCeilingFor (env wiring)", () => {
  it("reads MAX_HELD_AWAKE_SANDBOXES at module load", async () => {
    vi.resetModules();
    process.env.MAX_HELD_AWAKE_SANDBOXES = "7";
    const { heldAwakeCeilingFor } = await import("./due-work");
    expect(heldAwakeCeilingFor(caps(4))).toBe(7);
  });
});
