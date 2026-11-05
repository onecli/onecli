import { beforeEach, describe, expect, it, vi } from "vitest";

// The warm hint's fences, each one a cost the person never asked for if it
// is missing: a `failed` box re-claimed around its backoff, a keyless agent
// started into a certain failure, a foreign agent's box moved, a poll woken
// for nothing.

const store = vi.hoisted(() => ({
  sandbox: null as { id: string; status: string; workspaceId: string } | null,
  updated: [] as Array<{ where: unknown; data: unknown }>,
  blocker: null as { code: string; message: string } | null,
  findFirstThrows: false,
}));

const signal = vi.hoisted(() => ({ signalWork: vi.fn() }));

vi.mock("@onecli/db", () => ({
  db: {
    sandbox: {
      findFirst: async ({
        where,
      }: {
        where: {
          agentId: string;
          status: string;
          agent: { workspaceId: string };
        };
      }) => {
        if (store.findFirstThrows) throw new Error("db down");
        const s = store.sandbox;
        return s &&
          s.status === where.status &&
          s.workspaceId === where.agent.workspaceId
          ? { id: s.id }
          : null;
      },
      updateMany: async (args: {
        where: { id: string; status: string };
        data: unknown;
      }) => {
        store.updated.push(args);
        const s = store.sandbox;
        if (s && s.id === args.where.id && s.status === args.where.status) {
          s.status = "unprovisioned";
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  },
}));

vi.mock("./due-work", () => signal);

vi.mock("./llm-credential-service", () => ({
  findAgentLlmBlocker: async () => store.blocker,
}));

const { warmAgentSandbox } = await import("./sandbox-warm-service");

beforeEach(() => {
  store.sandbox = null;
  store.updated = [];
  store.blocker = null;
  store.findFirstThrows = false;
  signal.signalWork.mockClear();
});

describe("warmAgentSandbox", () => {
  it("flips a stopped box to unprovisioned and signals the held poll", async () => {
    store.sandbox = { id: "sb-1", status: "stopped", workspaceId: "p1" };
    await warmAgentSandbox("p1", "ag-1");
    expect(store.sandbox.status).toBe("unprovisioned");
    expect(store.updated).toEqual([
      {
        where: { id: "sb-1", status: "stopped" },
        data: { status: "unprovisioned", wakeReason: null },
      },
    ]);
    expect(signal.signalWork).toHaveBeenCalledOnce();
  });

  it("is idempotent: the second call finds nothing stopped and writes nothing", async () => {
    store.sandbox = { id: "sb-1", status: "stopped", workspaceId: "p1" };
    await warmAgentSandbox("p1", "ag-1");
    await warmAgentSandbox("p1", "ag-1");
    expect(store.updated).toHaveLength(1);
    expect(signal.signalWork).toHaveBeenCalledOnce();
  });

  it.each(["failed", "running", "starting", "unprovisioned"])(
    "leaves a %s box alone (only a parked one is woken by a look)",
    async (status) => {
      store.sandbox = { id: "sb-1", status, workspaceId: "p1" };
      await warmAgentSandbox("p1", "ag-1");
      expect(store.updated).toHaveLength(0);
      expect(signal.signalWork).not.toHaveBeenCalled();
    },
  );

  it("never moves another workspace's box", async () => {
    store.sandbox = { id: "sb-1", status: "stopped", workspaceId: "other" };
    await warmAgentSandbox("p1", "ag-1");
    expect(store.updated).toHaveLength(0);
  });

  it("never starts an agent that cannot run (no model key)", async () => {
    store.sandbox = { id: "sb-1", status: "stopped", workspaceId: "p1" };
    store.blocker = { code: "no_model_key", message: "no key" };
    await warmAgentSandbox("p1", "ag-1");
    expect(store.sandbox.status).toBe("stopped");
    expect(signal.signalWork).not.toHaveBeenCalled();
  });

  it("is best-effort: a failing read is swallowed, never thrown at the door", async () => {
    store.findFirstThrows = true;
    await expect(warmAgentSandbox("p1", "ag-1")).resolves.toBeUndefined();
    expect(signal.signalWork).not.toHaveBeenCalled();
  });
});
