import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The held-awake ceiling's NUMBER (step 13): env override wins, otherwise
 * `max(1, maxSandboxes − 1)` derived from the runner's own capabilities.
 * Module-load env means each case re-imports through vi.resetModules; the
 * eviction MECHANISM is proven on real PostgreSQL in processes.pg.test.ts.
 */

const ORIGINAL = process.env.MAX_HELD_AWAKE_SANDBOXES;

vi.mock("@onecli/db", () => ({ db: {}, Prisma: {} }));

const load = async (envValue?: string) => {
  vi.resetModules();
  if (envValue === undefined) {
    delete process.env.MAX_HELD_AWAKE_SANDBOXES;
  } else {
    process.env.MAX_HELD_AWAKE_SANDBOXES = envValue;
  }
  const { heldAwakeCeilingFor } = await import("./due-work");
  return heldAwakeCeilingFor;
};

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

describe("heldAwakeCeilingFor", () => {
  it("derives max(1, maxSandboxes − 1) when the env is unset", async () => {
    const ceilingFor = await load();
    expect(ceilingFor(caps(4))).toBe(3);
    expect(ceilingFor(caps(2))).toBe(1);
  });

  it("floors at 1 — a one-slot runner keeps keep-awake usable", async () => {
    const ceilingFor = await load();
    expect(ceilingFor(caps(1))).toBe(1);
  });

  it("treats unparseable capabilities as the conservative floor", async () => {
    const ceilingFor = await load();
    expect(ceilingFor(null)).toBe(1);
    expect(ceilingFor({ nonsense: true })).toBe(1);
  });

  it("the operator env overrides the derived default", async () => {
    const ceilingFor = await load("7");
    expect(ceilingFor(caps(4))).toBe(7);
  });

  it("an invalid env value falls back to derivation — never to unlimited", async () => {
    for (const bad of ["0", "-3", "x", ""]) {
      const ceilingFor = await load(bad);
      expect(ceilingFor(caps(4))).toBe(3);
    }
  });
});
