import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pinned onprem: the suite's laws below are edition-blind, but createAgent's
// cloud arm now runs the creation-world gate (§3.10 re-decided 2026-08-23),
// which the ambient-cloud CI lane would otherwise drag through every case.
// The gate reads the edition at CALL time, so its own describe block flips
// the env per test instead of forking a second file.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

// In-memory `@onecli/db` mock covering what `createAgent`/`updateAgent` touch.
// Two load-bearing laws live here: EVERY new agent is created `selective` with
// nothing attached (attach-model step 5), and EVERY create site stamps `kind`
// explicitly — hosted-agents step 1's BYO regression: an unadorned create
// still mints exactly the byo agent it always did.

interface AgentRow {
  id: string;
  workspaceId: string;
  identifier: string;
  name: string;
  kind?: string;
}

const ONLINE_RUNNER = {
  id: "runner-1",
  capabilities: {
    maxSandboxes: 4,
    backend: "docker",
    homeDurability: "resident",
  },
  _count: { sandboxes: 0 },
};

const store = vi.hoisted(() => ({
  agents: [] as AgentRow[],
  created: [] as Record<string, unknown>[],
  updated: [] as { where: unknown; data: Record<string, unknown> }[],
  createThrows: null as Error | null,
  // Step 3: what the placement seam sees. Default: one runner with capacity.
  runners: [] as Array<Record<string, unknown>>,
  // The org's creation world behind the workspace join (cloud gate only).
  orgByoLegacy: false,
  // The mixed-world column beside it (only read when byoLegacy is false).
  orgByoEnabled: false,
}));

// Step 9: render-input edits (name / instructions) reach a live sandbox as a
// home bump, never a respawn. Mocked so this suite pins the CALL-SITE
// guard; the bump's own fencing lives in home-sync.pg.test.ts.
const homeSync = vi.hoisted(() => ({
  bumpHomeForAgent: vi.fn(async () => {}),
}));

vi.mock("./home-sync-service", () => homeSync);

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, params: { code: string }) {
      super(message);
      this.code = params.code;
    }
  }
  return {
    Prisma: { PrismaClientKnownRequestError },
    db: {
      agent: {
        findFirst: async ({
          where,
        }: {
          where: { workspaceId: string; identifier?: string; id?: string };
        }) =>
          store.agents.find(
            (a) =>
              a.workspaceId === where.workspaceId &&
              (where.identifier !== undefined
                ? a.identifier === where.identifier
                : a.id === where.id),
          ) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (store.createThrows) throw store.createThrows;
          store.created.push(data);
          return {
            id: "new-agent",
            name: data.name,
            identifier: data.identifier,
            kind: data.kind,
            harness: data.harness,
            model: data.model,
            instructions: data.instructions,
            createdAt: new Date(0),
          };
        },
        update: async (args: {
          where: unknown;
          data: Record<string, unknown>;
        }) => {
          store.updated.push(args);
          return {};
        },
      },
      // Step 3: a hosted agent is placed on a runner at creation, so the
      // placement seam reads this. `store.runners` decides whether one is
      // available.
      runner: {
        findMany: async () => store.runners,
      },
      // The creation-world gate's workspace→org join (cloud only). Honors the
      // exact nested select createAgent passes; the query SHAPE itself is
      // proven against real Postgres in agent-service.pg.test.ts.
      workspace: {
        findUnique: async ({
          select,
        }: {
          where: { id: string };
          select: {
            organization: {
              select: { byoLegacy: boolean; byoEnabled: boolean };
            };
          };
        }) =>
          select.organization.select.byoLegacy &&
          select.organization.select.byoEnabled
            ? {
                organization: {
                  byoLegacy: store.orgByoLegacy,
                  byoEnabled: store.orgByoEnabled,
                },
              }
            : null,
      },
    },
  };
});

const { createAgent, updateAgent } = await import("./agent-service");
const { Prisma } = await import("@onecli/db");

const seedAgent = (identifier: string, kind = "byo") => {
  store.agents.push({
    id: `id-${identifier}`,
    workspaceId: "p1",
    identifier,
    name: identifier,
    kind,
  });
};

const lastCreated = () => store.created.at(-1)!;

beforeEach(() => {
  store.agents = [];
  store.created = [];
  store.updated = [];
  store.runners = [ONLINE_RUNNER];
  store.createThrows = null;
  store.orgByoLegacy = false;
  store.orgByoEnabled = false;
  homeSync.bumpHomeForAgent.mockClear();
});

describe("createAgent — the creation-world gates (cloud, §3.10 re-decided)", () => {
  // The gate reads the edition per call (policy-flags), so each case pins
  // cloud itself and the hook below restores the file's onprem pin.
  beforeEach(() => {
    process.env.NEXT_PUBLIC_EDITION = "cloud";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_EDITION = "onprem";
  });

  it("refuses BYO creation for a hosted-world org — including an omitted kind", async () => {
    // kind defaults to byo AFTER validation; the gate must see the defaulted
    // value, or a body that simply omits `kind` slips past it.
    for (const input of [
      { name: "N", identifier: "n1", kind: "byo" as const },
      { name: "N", identifier: "n2" },
    ]) {
      await expect(createAgent("p1", input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(store.created).toHaveLength(0);
  });

  it("lets a hosted-world org create hosted agents", async () => {
    await createAgent("p1", { name: "H", identifier: "h", kind: "hosted" });
    expect(lastCreated().kind).toBe("hosted");
  });

  it("refuses HOSTED creation for a BYO-world org", async () => {
    store.orgByoLegacy = true;
    await expect(
      createAgent("p1", { name: "H", identifier: "h", kind: "hosted" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.created).toHaveLength(0);
  });

  it("lets a BYO-world org create BYO agents", async () => {
    store.orgByoLegacy = true;
    await createAgent("p1", { name: "B", identifier: "b" });
    expect(lastCreated().kind).toBe("byo");
  });

  it("lets a MIXED-world org create BOTH kinds (byoEnabled beside the hosted default)", async () => {
    // The gradual-migration world (2026-08-29): byoLegacy=false keeps hosted
    // as the default door, byoEnabled=true re-opens BYO creation beside it.
    store.orgByoEnabled = true;
    await createAgent("p1", { name: "B", identifier: "mixed-b" });
    expect(lastCreated().kind).toBe("byo");
    await createAgent("p1", {
      name: "H",
      identifier: "mixed-h",
      kind: "hosted",
    });
    expect(lastCreated().kind).toBe("hosted");
  });

  it("ignores byoEnabled in a BYO-world org — byoLegacy wins, hosted stays refused", async () => {
    // byoEnabled is only consulted when byoLegacy is false: a legacy org
    // keeps its exact behavior whatever the new column says.
    store.orgByoLegacy = true;
    store.orgByoEnabled = true;
    await expect(
      createAgent("p1", { name: "H", identifier: "h", kind: "hosted" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.created).toHaveLength(0);
    await createAgent("p1", { name: "B", identifier: "b" });
    expect(lastCreated().kind).toBe("byo");
  });

  it("answers 409, not 403, for an existing identifier — ensureAgent stays idempotent", async () => {
    seedAgent("taken");
    await expect(
      createAgent("p1", { name: "T", identifier: "taken" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stays ungated on self-host — both kinds, both worlds", async () => {
    process.env.NEXT_PUBLIC_EDITION = "onprem";
    for (const orgByoLegacy of [false, true]) {
      store.orgByoLegacy = orgByoLegacy;
      await createAgent("p1", { name: "B", identifier: `b-${orgByoLegacy}` });
      expect(lastCreated().kind).toBe("byo");
      await createAgent("p1", {
        name: "H",
        identifier: `h-${orgByoLegacy}`,
        kind: "hosted",
      });
      expect(lastCreated().kind).toBe("hosted");
    }
  });
});

describe("createAgent — no parent-mode inheritance (attach-model step 5)", () => {
  it("creates the agent without threading any parent state", async () => {
    // The step-5 law: inheritance is gone (the route still accepts
    // `parentIdentifier` but no longer threads it), and since the
    // `secret_mode` drop there is no mode to inherit at all — access is
    // granted solely by policy rules after creation.
    seedAgent("parent");
    await createAgent("p1", { name: "Child", identifier: "child" });
    expect(lastCreated().name).toBe("Child");
    expect(lastCreated().identifier).toBe("child");
  });
});

describe("createAgent — the BYO regression (hosted-agents step 1)", () => {
  it("an unadorned create stamps kind byo explicitly with null hosted fields", async () => {
    await createAgent("p1", { name: "Legacy", identifier: "legacy" });
    expect(lastCreated()).toMatchObject({
      kind: "byo",
      harness: null,
      instructions: null,
    });
  });

  it("rejects hosted-only fields on a byo create", async () => {
    for (const extra of [
      { harness: "jcode" },
      { instructions: "triage support" },
    ]) {
      await expect(
        createAgent("p1", { name: "N", identifier: "n", ...extra }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});

describe("createAgent — hosted", () => {
  it("defaults the harness to jcode and carries a trimmed brief", async () => {
    await createAgent("p1", {
      name: "Support Triager",
      identifier: "support",
      kind: "hosted",
      instructions: "  Triage the support inbox.  ",
    });
    expect(lastCreated()).toMatchObject({
      kind: "hosted",
      harness: "jcode",
      instructions: "Triage the support inbox.",
    });
  });

  it("never sets a model at creation — the granted key decides it", async () => {
    // §3.10. A model written here would also have no provider stamp beside it,
    // which the agents table's CHECK constraint rejects outright.
    await createAgent("p1", {
      name: "Support Triager",
      identifier: "support",
      kind: "hosted",
    });
    expect(lastCreated()).not.toHaveProperty("model");
  });

  it("stores an explicit harness and null for omitted optionals", async () => {
    await createAgent("p1", {
      name: "H",
      identifier: "h",
      kind: "hosted",
      harness: "other",
    });
    expect(lastCreated()).toMatchObject({
      kind: "hosted",
      harness: "other",
      instructions: null,
    });
  });

  it("normalizes an empty instructions string to null", async () => {
    await createAgent("p1", {
      name: "H2",
      identifier: "h2",
      kind: "hosted",
      instructions: "   ",
    });
    expect(lastCreated().instructions).toBeNull();
  });
});

describe("createAgent — validation", () => {
  it("rejects a blank or over-long name", async () => {
    await expect(
      createAgent("p1", { name: "   ", identifier: "a" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createAgent("p1", { name: "x".repeat(256), identifier: "a" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each(["Caps", "-leading", "has space", "under_score", "x".repeat(51)])(
    "rejects the identifier %j",
    async (identifier) => {
      await expect(
        createAgent("p1", { name: "Name", identifier }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it.each(["a", "agent-1", "9lives", "x".repeat(50)])(
    "accepts the identifier %j",
    async (identifier) => {
      await expect(
        createAgent("p1", { name: "Name", identifier }),
      ).resolves.toBeTruthy();
    },
  );

  it("trims the name and identifier before use", async () => {
    await createAgent("p1", { name: "  Padded  ", identifier: "  padded  " });
    expect(lastCreated()).toMatchObject({
      name: "Padded",
      identifier: "padded",
    });
  });

  it("409s on a duplicate identifier in the same workspace", async () => {
    seedAgent("taken");
    await expect(
      createAgent("p1", { name: "Name", identifier: "taken" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps a racing unique-constraint violation to the same 409", async () => {
    store.createThrows = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    await expect(
      createAgent("p1", { name: "Name", identifier: "racy" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not swallow an unrelated database error", async () => {
    store.createThrows = new Error("connection reset");
    await expect(
      createAgent("p1", { name: "Name", identifier: "boom" }),
    ).rejects.toThrow("connection reset");
  });

  it("issues a distinct access token per agent", async () => {
    await createAgent("p1", { name: "One", identifier: "one" });
    await createAgent("p1", { name: "Two", identifier: "two" });
    const [a, b] = store.created.map((c) => c.accessToken as string);
    expect(a).toMatch(/^aoc_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("updateAgent", () => {
  it("renames like renameAgent always did", async () => {
    seedAgent("byo-1");
    await updateAgent("p1", "id-byo-1", { name: "  New Name  " });
    expect(store.updated.at(-1)!.data).toEqual({ name: "New Name" });
  });

  it("updates the brief on a hosted agent and clears it with null or empty", async () => {
    seedAgent("host-1", "hosted");
    await updateAgent("p1", "id-host-1", { instructions: "Be terse." });
    expect(store.updated.at(-1)!.data).toEqual({ instructions: "Be terse." });
    // Step 9: a brief edit reaches a LIVE sandbox as a home bump.
    expect(homeSync.bumpHomeForAgent).toHaveBeenCalledWith("id-host-1");

    await updateAgent("p1", "id-host-1", { instructions: null });
    expect(store.updated.at(-1)!.data).toEqual({ instructions: null });

    await updateAgent("p1", "id-host-1", { instructions: "   " });
    expect(store.updated.at(-1)!.data).toEqual({ instructions: null });
  });

  it("bumps the home only for hosted agents whose render inputs MOVED", async () => {
    // A BYO agent has no sandbox — a rename must not bump.
    seedAgent("byo-quiet");
    await updateAgent("p1", "id-byo-quiet", { name: "Renamed" });
    expect(homeSync.bumpHomeForAgent).not.toHaveBeenCalled();

    // A hosted no-op PATCH (same name re-sent) must not bump either —
    // the settings-form change-your-mind case.
    seedAgent("host-quiet", "hosted");
    await updateAgent("p1", "id-host-quiet", { name: "host-quiet" });
    expect(homeSync.bumpHomeForAgent).not.toHaveBeenCalled();

    // A hosted rename that actually moves the value does.
    await updateAgent("p1", "id-host-quiet", { name: "Renamed" });
    expect(homeSync.bumpHomeForAgent).toHaveBeenCalledWith("id-host-quiet");
  });

  it("rejects instructions on a byo agent", async () => {
    seedAgent("byo-2");
    await expect(
      updateAgent("p1", "id-byo-2", { instructions: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an empty patch and a blank name", async () => {
    seedAgent("byo-3");
    await expect(updateAgent("p1", "id-byo-3", {})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      updateAgent("p1", "id-byo-3", { name: "  " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("404s on an unknown agent", async () => {
    await expect(
      updateAgent("p1", "missing", { name: "X" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createAgent — placement (hosted-agents step 3)", () => {
  it("refuses a hosted agent when no runner can host it", async () => {
    store.runners = [];

    await expect(
      createAgent("p1", {
        name: "Homeless",
        identifier: "homeless",
        kind: "hosted",
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    // Nothing half-created: no agent without a computer.
    expect(store.created).toHaveLength(0);
  });

  it("refuses a hosted agent when every runner is at capacity", async () => {
    store.runners = [
      {
        ...ONLINE_RUNNER,
        capabilities: { ...ONLINE_RUNNER.capabilities, maxSandboxes: 1 },
        _count: { sandboxes: 1 },
      },
    ];

    await expect(
      createAgent("p1", { name: "Full", identifier: "full", kind: "hosted" }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("creates the sandbox alongside the agent, on the chosen runner", async () => {
    await createAgent("p1", {
      name: "Hosted",
      identifier: "hosted",
      kind: "hosted",
    });

    expect(store.created[0]).toMatchObject({
      kind: "hosted",
      sandbox: { create: { runnerId: "runner-1", status: "unprovisioned" } },
    });
  });

  it("still creates a BYO agent with no runner at all, and no sandbox", async () => {
    store.runners = [];

    await createAgent("p1", { name: "Plain", identifier: "plain" });

    expect(store.created[0]).toMatchObject({ kind: "byo" });
    expect(store.created[0]?.sandbox).toBeUndefined();
  });
});
